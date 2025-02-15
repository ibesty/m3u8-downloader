import os from "node:os";
import fs from "fs-extra";
import path from "node:path";
import { TypedEmitter } from "tiny-typed-emitter";

import ffmpeg from "fluent-ffmpeg";
import axios from "axios";
import axiosRetry from "axios-retry";
import PQueue from "p-queue";
import * as m3u8Parser from "m3u8-parser";
import { isUrl } from "./utils.js";

import type { RawAxiosRequestHeaders, AxiosProxyConfig, AxiosRequestConfig } from "axios";

// for vitest
declare global {
  interface Worker {}

  namespace WebAssembly {
    interface Module {}
  }
  interface WebSocket {}
}

interface M3U8DownloaderEvents {
  start: () => void;
  progress: (progress: {
    downloadedFile: string;
    downloaded: number;
    total: number;
  }) => void;
  paused: () => void;
  resumed: () => void;
  canceled: () => void;
  error: (error: string) => void;
  completed: () => void;
  converted: (output: string) => void;
}

export default class M3U8Downloader extends TypedEmitter<M3U8DownloaderEvents> {
  private m3u8Url: string;
  output: string;
  private segmentsDir: string;
  private queue: PQueue;
  private totalSegments: number;
  private downloadedSegments: number;
  private downloadedFiles: string[];
  status:
    | "pending"
    | "running"
    | "paused"
    | "canceled"
    | "completed"
    | "error" = "pending";
  private options: {
    concurrency: number;
    convert2Mp4: boolean;
    mergeSegments: boolean;
    segmentsDir: string;
    ffmpegPath: string;
    retries: number;
    clean: boolean;
    headers: RawAxiosRequestHeaders;
    startIndex: number;
    endIndex?: number;
    skipExistSegments: boolean;
    proxy?: {
      protocol?: string;
      host: string;
      port: number;
      auth?: {
        username: string;
        password: string;
      };
    };
  };

  /**
   * @param m3u8Url M3U8 URL
   * @param options
   * @param options.concurrency Number of segments to download concurrently
   * @param options.segmentsDir Temporary directory to store downloaded segments
   * @param options.mergeSegments Whether to merge downloaded segments into a single file
   * @param options.convert2Mp4 Whether to convert2Mp4 downloaded segments into a single file, you must open mergeSegments
   * @param options.ffmpegPath Path to ffmpeg binary if you open convert2Mp4
   * @param options.retries Number of retries for downloading segments
   * @param options.clean Whether to clean up downloaded segments after download is error or canceled
   * @param options.headers Headers to be sent with the HTTP request
   * @param options.startIndex Start index of the segment to download
   * @param options.endIndex End index of the segment to download
   * @param options.skipExistSegments Skip download if the segment file already exists
   * @param options.proxy Axios proxy configuration object
   */
  constructor(
    m3u8Url: string,
    output: string,
    options: {
      concurrency?: number;
      segmentsDir?: string;
      convert2Mp4?: boolean;
      mergeSegments?: boolean;
      ffmpegPath?: string;
      retries?: number;
      clean?: boolean;
      headers?: RawAxiosRequestHeaders;
      startIndex?: number;
      endIndex?: number;
      skipExistSegments?: boolean;
      proxy?: AxiosProxyConfig;
    } = {}
  ) {
    super();
    const defaultOptions = {
      concurrency: 5,
      convert2Mp4: false,
      mergeSegments: true,
      segmentsDir: os.tmpdir(),
      retries: 3,
      ffmpegPath: "ffmpeg",
      clean: true,
      startIndex: 0,
      skipExistSegments: false,
      headers: {},
      proxy: false,
    };
    this.options = Object.assign(defaultOptions, options);
    this.m3u8Url = m3u8Url;
    this.output = output;
    this.segmentsDir = this.options.segmentsDir;
    this.queue = new PQueue({ concurrency: this.options.concurrency });
    this.totalSegments = 0;
    this.downloadedSegments = 0;
    this.downloadedFiles = [];

    axiosRetry(axios, {
      retries: this.options.retries,
      retryDelay: axiosRetry.exponentialDelay,
    });

    if (this.options.convert2Mp4) {
      ffmpeg.setFfmpegPath(this.options.ffmpegPath);
    }

    this.on("canceled", this.cleanUpDownloadedFiles);
    this.on("error", async error => {
      console.error("error", error);
      this.status = "error";
      this.cleanUpDownloadedFiles();
    });
    this.on("completed", () => {
      this.status = "completed";
    });
  }

  /**
   * download M3U8 file
   */
  public async download() {
    try {
      this.emit("start");
      this.status = "running";
      if (!(await fs.pathExists(this.segmentsDir))) {
        await fs.mkdir(this.segmentsDir, { recursive: true });
      }
      if (!(await fs.pathExists(path.dirname(this.output)))) {
        throw new Error("Output directory does not exist");
      }
      const m3u8Content = await this.getM3U8();
      const tsUrls = this.parseM3U8(m3u8Content);
      const urls = tsUrls.slice(this.options.startIndex, this.options.endIndex);
      this.totalSegments = urls.length;

      await this.downloadTsSegments(urls);

      if (this.options.mergeSegments) {
        const tsMediaPath = await this.mergeTsSegments(this.totalSegments);

        if (this.options.convert2Mp4) {
          await this.convertToMp4(tsMediaPath);
        }
      }

      if (!this.isRunning()) {
        await this.cleanUpDownloadedFiles();
        return;
      }
      this.emit("completed");
    } catch (error) {
      this.emit("error", error);
    }
  }

  /**
   * pause download
   */
  public pause() {
    if (!this.isRunning()) return;

    // running in queue will not be paused
    this.status = "paused";
    this.emit("paused");
    this.queue.pause();
  }

  /**
   * resume download
   */
  public resume() {
    if (this.status !== "paused") return;
    this.status = "running";
    this.emit("resumed");
    this.queue.start();
  }

  /**
   * cancel download
   */
  public cancel() {
    if (["completed", "canceled", "error"].includes(this.status)) return;

    this.status = "canceled";
    this.emit("canceled");
    this.queue.clear();
  }

  /**
   * download M3U8 file
   */
  private async getM3U8(): Promise<string> {
    try {
      const config: AxiosRequestConfig = {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
          ...this.options.headers,
        },
      };

      if (this.options.proxy) {
        config.proxy = this.options.proxy;
      }

      const { data: m3u8Content } = await axios.get(this.m3u8Url, config);
      return m3u8Content;
    } catch (error) {
      this.emit("error", "Failed to download m3u8 file");
      throw error;
    }
  }

  /**
   * parse M3U8 file and return an array of URLs
   * @param m3u8Content M3U8 file content
   */
  private parseM3U8(m3u8Content: string): string[] {
    const parser = new m3u8Parser.Parser();

    parser.push(m3u8Content);
    parser.end();

    const parsedManifest = parser.manifest;
    return (parsedManifest?.segments || []).map(segment => {
      if (isUrl(segment.uri)) {
        return segment.uri;
      } else {
        return new URL(segment.uri, this.m3u8Url).href;
      }
    });
  }

  private async downloadSegment(tsUrl: string, index: number) {
    if (!this.isRunning()) return;
    const formattedIndex = String(index).padStart(5, "0");
    const segmentPath = path.resolve(
      this.segmentsDir,
      `segment${formattedIndex}.ts`
    );
    if (this.options.skipExistSegments && (await fs.pathExists(segmentPath))) {
      this.downloadedSegments++;
      const progress = {
        downloadedFile: segmentPath,
        downloaded: this.downloadedSegments,
        total: this.totalSegments,
      };
      this.emit("progress", progress);
      return progress;
    }

    const config: AxiosRequestConfig = {
      responseType: "arraybuffer",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
        ...this.options.headers,
      },
    };

    if (this.options.proxy) {
      config.proxy = this.options.proxy;
    }

    const response = await axios.get(tsUrl, config);

    await fs.writeFile(segmentPath, response.data);
    this.downloadedFiles.push(segmentPath);
    this.downloadedSegments++;
    const progress = {
      downloadedFile: segmentPath,
      downloaded: this.downloadedSegments,
      total: this.totalSegments,
    };
    this.emit("progress", progress);

    return progress;
  }

  /**
   * download TS segments
   * @param tsUrls Array of TS segment URLs
   */
  private async downloadTsSegments(tsUrls: string[]) {
    for (const [index, tsUrl] of tsUrls.entries()) {
      this.queue
        .add(() => this.downloadSegment(tsUrl, index))
        .catch(error => {
          this.emit("error", `Failed to add segment ${index} to queue`);
        });
    }

    await this.queue.onIdle();
  }

  /**
   * merge TS segments into a single file
   * @param total Total number of segments to merge
   */
  private async mergeTsSegments(total: number) {
    if (!this.isRunning()) return;
    let mergedFilePath = path.resolve(this.segmentsDir, "output.ts");

    if (!this.options.convert2Mp4) {
      mergedFilePath = this.output;
    }

    const writeStream = fs.createWriteStream(mergedFilePath, { flags: "a" });

    try {
      for (let index = 0; index < total; index++) {
        if (!this.isRunning()) {
          writeStream.end();
          await fs.unlink(mergedFilePath);
          return;
        }

        const formattedIndex = String(index).padStart(5, "0");
        const segmentPath = path.resolve(
          this.segmentsDir,
          `segment${formattedIndex}.ts`
        );

        try {
          const segmentData = await fs.readFile(segmentPath);
          writeStream.write(segmentData);

          // 只有在合并后要转换为 MP4 时才删除源文件
          if (this.options.convert2Mp4) {
            await fs.unlink(segmentPath);
          }
        } catch (error) {
          writeStream.end();
          await fs.unlink(mergedFilePath);
          this.emit(
            "error",
            `Failed to process segment ${index}: ${error.message}`
          );
          return;
        }
      }

      await new Promise(resolve => writeStream.end(resolve));
      return mergedFilePath;
    } catch (error) {
      writeStream.end();
      await fs.unlink(mergedFilePath);
      this.emit("error", `Failed to merge segments: ${error.message}`);
      return;
    }
  }

  private async cleanUpDownloadedFiles() {
    if (!this.options.clean) return;
    await Promise.all(
      this.downloadedFiles.map(async file => {
        try {
          await fs.unlink(file);
        } catch (error) {}
      })
    );
    if (this.options.convert2Mp4) {
      let mergedFilePath = path.resolve(this.segmentsDir, "output.ts");
      if (await fs.pathExists(mergedFilePath)) {
        await fs.unlink(mergedFilePath);
      }
    }
  }

  /**
   * convert merged TS file to MP4
   * @param tsMediaPath Path to merged TS file
   */
  private async convertToMp4(tsMediaPath: string) {
    if (!this.isRunning()) return;

    const fileExist = await fs.pathExists(tsMediaPath);

    if (!fileExist) {
      this.emit("error", `Merged TS file does not exist: ${tsMediaPath}`);
      return;
    }

    const inputFilePath = tsMediaPath;
    const outputFilePath = this.output;

    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputFilePath)
        .videoCodec("copy")
        .audioCodec("copy")
        .output(outputFilePath)
        .on("end", () => {
          fs.unlinkSync(inputFilePath); // remove merged TS file
          resolve(outputFilePath);
          this.emit("converted", outputFilePath);
        })
        .on("error", error => {
          this.emit("error", `Failed to convert to MP4: ${error.message}`);
          reject(error);
        });

      command.run();
    });
  }

  isRunning() {
    return this.status === "running";
  }
}

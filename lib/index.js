var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { Service } from "cordis";
var DETAILED_MILESTONES = [
  1e5,
  2e5,
  3e5,
  4e5,
  5e5,
  6e5,
  7e5,
  8e5,
  9e5,
  1e6,
  2e6,
  3e6,
  4e6,
  5e6,
  6e6,
  7e6,
  8e6,
  9e6,
  1e7,
  2e7,
  1e8
].sort((a, b) => a - b);
var NORMAL_UPDATE_CONFIG = {
  MIN_INTERVAL_SECONDS: 20 * 60,
  MAX_INTERVAL_SECONDS: 4 * 60 * 60,
  DECAY_RATE: 0.05,
  JITTER_PERCENTAGE: 0.15
};
var APPROACHING_UPDATE_CONFIG = {
  MIN_INTERVAL_SECONDS: 75,
  MAX_INTERVAL_SECONDS: 10 * 60,
  DECAY_RATE: 0.3,
  JITTER_PERCENTAGE: 0.1,
  PROXIMITY_SENSITIVITY: 2
};
var LfvsCoreService = class extends Service {
  static {
    __name(this, "LfvsCoreService");
  }
  static inject = [];
  adapters = /* @__PURE__ */ new Map();
  constructor(ctx) {
    super(ctx, "lfvs.core");
  }
  registerAdapter(adapter) {
    this.adapters.set(adapter.platform, adapter);
  }
  unregisterAdapter(platform) {
    this.adapters.delete(platform);
  }
  getAdapter(platform) {
    return this.adapters.get(platform);
  }
};
var AbstractScheduleService = class extends Service {
  static {
    __name(this, "AbstractScheduleService");
  }
  static inject = ["database", "timer", "lfvs.core", "logger"];
  config;
  isUpdatingVideos = false;
  isScanningUploaders = false;
  videoIntervalId;
  uploaderIntervalId;
  abortController;
  constructor(ctx, serviceName, config) {
    super(ctx, serviceName);
    this.config = config;
    this.abortController = new AbortController();
    ctx.effect(() => {
      return () => {
        this.abortController.abort();
      };
    });
    Promise.resolve().then(() => this.start().catch((e) => {
      this.ctx.emit("lfvs/log", this.logPrefix, "error", `启动失败: ${e.message}`);
    }));
  }
  async start() {
    if (!this.config.enablePolling) return;
    this.ctx.on("lfvs/adapter-online", (platform) => {
      if (platform === this.platform) {
        this.startPolling();
      }
    });
    this.ctx.on("lfvs/adapter-offline", (platform) => {
      if (platform === this.platform) {
        this.stopPolling();
      }
    });
    if (this.ctx.get("lfvs.core").getAdapter(this.platform)) {
      this.startPolling();
    }
  }
  sleep(ms) {
    return new Promise((resolve, reject) => {
      if (this.abortController.signal.aborted) {
        return reject(new Error("Context disposed"));
      }
      const timer = setTimeout(() => {
        this.abortController.signal.removeEventListener("abort", abortHandler);
        resolve();
      }, ms);
      const abortHandler = /* @__PURE__ */ __name(() => {
        clearTimeout(timer);
        reject(new Error("Context disposed"));
      }, "abortHandler");
      this.abortController.signal.addEventListener("abort", abortHandler);
    });
  }
  startPolling() {
    if (this.videoIntervalId) return;
    this.videoIntervalId = this.ctx.timer.setInterval(() => this.updateVideos(), this.config.queueScanInterval);
    this.uploaderIntervalId = this.ctx.timer.setInterval(() => this.scanUploaders(), this.config.uploaderScanInterval);
    this.ctx.setTimeout(() => {
      this.updateVideos();
      this.scanUploaders();
    }, 1e3);
  }
  stopPolling() {
    if (this.videoIntervalId) this.videoIntervalId();
    if (this.uploaderIntervalId) this.uploaderIntervalId();
    this.videoIntervalId = void 0;
    this.uploaderIntervalId = void 0;
  }
  calculateHybridInterval(viewDelta, timeDeltaInMinutes, distanceToNextMilestone) {
    const isApproaching = distanceToNextMilestone !== null;
    const MIN_INTERVAL_SECONDS = isApproaching ? this.config.approachingMinInterval : this.config.normalMinInterval;
    const MAX_INTERVAL_SECONDS = isApproaching ? this.config.approachingMaxInterval : this.config.normalMaxInterval;
    const DECAY_RATE = this.config.normalDecayRate;
    const JITTER_PERCENTAGE = this.config.jitterPercentage;
    if (timeDeltaInMinutes <= 0) return MAX_INTERVAL_SECONDS;
    const viewsPerMinute = viewDelta / timeDeltaInMinutes;
    let baseInterval = MIN_INTERVAL_SECONDS + (MAX_INTERVAL_SECONDS - MIN_INTERVAL_SECONDS) * Math.exp(-DECAY_RATE * viewsPerMinute);
    if (isApproaching && distanceToNextMilestone > 0) {
      const proximityFactor = 1 - Math.exp(-this.config.proximitySensitivity * (distanceToNextMilestone / 1e5));
      const proximityAdjustedInterval = MIN_INTERVAL_SECONDS + (baseInterval - MIN_INTERVAL_SECONDS) * proximityFactor;
      baseInterval = proximityAdjustedInterval;
    }
    const jitter = (Math.random() * 2 - 1) * baseInterval * JITTER_PERCENTAGE;
    const finalInterval = baseInterval + jitter;
    return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, finalInterval));
  }
  async updateVideos() {
    if (this.isUpdatingVideos) return;
    this.isUpdatingVideos = true;
    const roundStart = Date.now();
    const windowMs = this.config.queueScanInterval;
    const MAX_PROCESS = this.config.maxVideoProcess;
    const MIN_INTERVAL_MS = windowMs / MAX_PROCESS;
    let totalSuccess = 0;
    let totalFailure = 0;
    let totalProcessed = 0;
    try {
      const now = /* @__PURE__ */ new Date();
      const dbStart = Date.now();
      const videosToUpdate = await this.ctx.database.get("lfvs_video", {
        isSubscribed: true,
        status: "active",
        platform: this.platform,
        nextUpdateAt: { $lte: now }
      }, { limit: MAX_PROCESS, sort: { nextUpdateAt: "asc" } });
      const dbCostMs = Date.now() - dbStart;
      if (videosToUpdate.length === 0) return;
      this.ctx.emit("lfvs/schedule-round-start", this.platform, "video", dbCostMs, videosToUpdate.length);
      const intervalMs = Math.max(MIN_INTERVAL_MS, windowMs / videosToUpdate.length);
      totalProcessed = videosToUpdate.length;
      for (const video of videosToUpdate) {
        if (this.abortController.signal.aborted) break;
        try {
          const result = await this.processSingleVideo(video);
          if (result) totalSuccess++;
          else totalFailure++;
        } catch (error) {
          if (error.message === "Context disposed") break;
          totalFailure++;
          this.ctx.emit("lfvs/log", this.logPrefix, "error", `updateVideos 异常: ${error.message}`);
        }
        if (!this.abortController.signal.aborted) {
          try {
            await this.sleep(intervalMs);
          } catch {
            break;
          }
        }
      }
    } finally {
      this.isUpdatingVideos = false;
      if (totalProcessed > 0 && !this.abortController.signal.aborted) {
        this.ctx.emit("lfvs/schedule-round-end", this.platform, "video", totalProcessed, totalSuccess, totalFailure, Date.now() - roundStart);
      }
    }
  }
  async processSingleVideo(video) {
    const adapter = this.ctx.get("lfvs.core").getAdapter(this.platform);
    if (!adapter) return false;
    const now = /* @__PURE__ */ new Date();
    const start = Date.now();
    try {
      const res = await adapter.getVideoInfoAndStats(video.videoId);
      const costMs = Date.now() - start;
      if (res.status === "not_found") {
        await this.ctx.database.set("lfvs_video", { id: video.id }, {
          status: "deleted",
          isSubscribed: false
        });
        this.ctx.emit("lfvs/resource-deleted", this.platform, "video", video.videoId);
        this.ctx.emit("lfvs/video-updated", this.platform, video.videoId, "not_found", costMs);
        return true;
      }
      if (res.status === "error") {
        const retryDelaySeconds = 20 * 60;
        await this.ctx.database.set("lfvs_video", { id: video.id }, {
          nextUpdateAt: new Date(Date.now() + retryDelaySeconds * 1e3)
        });
        this.ctx.emit("lfvs/video-updated", this.platform, video.videoId, "error", costMs);
        return false;
      }
      const { stat: newStat, info } = res.data;
      let videoUploaderId = video.uploaderId;
      let needsMetadataUpdate = false;
      if (info && (!videoUploaderId || !video.title || !video.pic || !video.pubdate)) {
        if (!videoUploaderId && info.uploader) {
          const upCheck = await this.ctx.database.get("lfvs_uploader", {
            uid: info.uploader.uid,
            platform: this.platform
          }, ["id"]);
          if (upCheck.length > 0) {
            videoUploaderId = upCheck[0].id;
          } else {
            const createdUp = await this.ctx.database.create("lfvs_uploader", {
              uid: info.uploader.uid,
              name: info.uploader.name,
              platform: this.platform,
              isSubscribed: false,
              status: "active"
            });
            videoUploaderId = createdUp.id;
          }
        }
        needsMetadataUpdate = true;
      }
      const latestStats = await this.ctx.database.get("lfvs_video_stat", { videoId: video.id }, {
        sort: { timestamp: "desc" },
        limit: 1
      });
      const latestStat = latestStats[0];
      let dataHasChanged = true;
      if (latestStat) {
        const n = /* @__PURE__ */ __name((v) => v ?? 0, "n");
        if (n(newStat.view) === latestStat.view && n(newStat.danmaku) === latestStat.danmaku && n(newStat.reply) === latestStat.reply && n(newStat.favorite) === latestStat.favorite && n(newStat.coin) === latestStat.coin && n(newStat.share) === latestStat.share && n(newStat.like) === latestStat.like) {
          dataHasChanged = false;
        }
      }
      const milestonesToCreate = [];
      if (dataHasChanged && latestStat) {
        const milestonesCrossed = DETAILED_MILESTONES.filter((m) => latestStat.view < m && (newStat.view || 0) >= m);
        if (milestonesCrossed.length > 0) {
          const fullStat = {
            id: 0,
            videoId: video.id,
            timestamp: now,
            view: newStat.view || 0,
            danmaku: newStat.danmaku || 0,
            reply: newStat.reply || 0,
            favorite: newStat.favorite || 0,
            coin: newStat.coin || 0,
            share: newStat.share || 0,
            like: newStat.like || 0
          };
          for (const milestone of milestonesCrossed) {
            milestonesToCreate.push({ videoId: video.id, milestoneView: milestone, achievedAt: now });
            this.ctx.emit("lfvs/milestone-reached", video, milestone, fullStat);
          }
        }
      }
      let newInterval;
      let distance = null;
      const nextMilestone = DETAILED_MILESTONES.find((m) => m > (newStat.view || 0));
      if (nextMilestone && (newStat.view || 0) >= nextMilestone * 0.9) {
        distance = nextMilestone - (newStat.view || 0);
      }
      if (latestStat) {
        const viewDelta = dataHasChanged ? (newStat.view || 0) - latestStat.view : 0;
        const timeDelta = (now.getTime() - latestStat.timestamp.getTime()) / (1e3 * 60);
        newInterval = this.calculateHybridInterval(viewDelta, timeDelta, distance);
      } else {
        newInterval = 300;
        this.ctx.emit("lfvs/new-video-found", video);
      }
      const nextUpdateAt = new Date(Date.now() + newInterval * 1e3);
      if (dataHasChanged) {
        await this.ctx.database.create("lfvs_video_stat", {
          videoId: video.id,
          timestamp: now,
          view: newStat.view || 0,
          danmaku: newStat.danmaku || 0,
          reply: newStat.reply || 0,
          favorite: newStat.favorite || 0,
          coin: newStat.coin || 0,
          share: newStat.share || 0,
          like: newStat.like || 0
        });
        if (milestonesToCreate.length > 0) {
          await this.ctx.database.upsert("lfvs_milestone", milestonesToCreate);
        }
      } else if (latestStat) {
        await this.ctx.database.set("lfvs_video_stat", { id: latestStat.id }, { timestamp: now });
      }
      const updatePayload = {
        updateInterval: Math.round(newInterval),
        nextUpdateAt,
        title: info.title,
        pic: info.pic,
        currentView: newStat.view || 0
      };
      if (needsMetadataUpdate) {
        if (videoUploaderId) updatePayload.uploaderId = videoUploaderId;
        if (info.pubdate) updatePayload.pubdate = info.pubdate;
      }
      await this.ctx.database.set("lfvs_video", { id: video.id }, updatePayload);
      const fullNewStat = { id: 0, videoId: video.id, timestamp: now, view: newStat.view || 0, danmaku: newStat.danmaku || 0, reply: newStat.reply || 0, favorite: newStat.favorite || 0, coin: newStat.coin || 0, share: newStat.share || 0, like: newStat.like || 0 };
      this.ctx.emit("lfvs/video-updated", this.platform, video.videoId, "success", costMs, latestStat, fullNewStat);
      return true;
    } catch (error) {
      this.ctx.emit(
        "lfvs/log",
        this.logPrefix,
        "error",
        `processSingleVideo 异常 [${video.videoId}]: ${error.message}`,
        error.stack
      );
      return false;
    }
  }
  async scanUploaders() {
    if (this.isScanningUploaders) return;
    this.isScanningUploaders = true;
    const roundStart = Date.now();
    const adapter = this.ctx.get("lfvs.core").getAdapter(this.platform);
    if (!adapter) {
      this.isScanningUploaders = false;
      return;
    }
    try {
      const dbStart = Date.now();
      const uploaders = await this.ctx.database.get("lfvs_uploader", {
        isSubscribed: true,
        status: "active",
        platform: this.platform
      }, { limit: this.config.maxUploaderProcess, sort: { id: "asc" } });
      const dbCostMs = Date.now() - dbStart;
      if (uploaders.length > 0) {
        this.ctx.emit("lfvs/schedule-round-start", this.platform, "uploader", dbCostMs, uploaders.length);
      }
      let totalSuccess = 0;
      let totalFailure = 0;
      for (const uploader of uploaders) {
        if (this.abortController.signal.aborted) break;
        const res = await adapter.getUploaderRecentVideos(uploader.uid);
        if (res.status === "not_found") {
          await this.ctx.database.set("lfvs_uploader", { id: uploader.id }, { status: "deleted", isSubscribed: false });
          this.ctx.emit("lfvs/resource-deleted", this.platform, "uploader", uploader.uid);
          totalSuccess++;
          continue;
        } else if (res.status === "error") {
          totalFailure++;
          continue;
        }
        totalSuccess++;
        const recentVideos = res.data;
        if (recentVideos.length === 0) continue;
        const videoIds = recentVideos.map((v) => v.videoId);
        const existingVideosDb = await this.ctx.database.get("lfvs_video", {
          videoId: videoIds,
          platform: this.platform
        }, ["videoId"]);
        const existingVideoIds = new Set(existingVideosDb.map((v) => v.videoId));
        let uploaderNameUpdated = false;
        const now = /* @__PURE__ */ new Date();
        for (const vInfo of recentVideos) {
          if (!existingVideoIds.has(vInfo.videoId)) {
            if (!uploaderNameUpdated && uploader.name !== vInfo.uploader.name) {
              await this.ctx.database.set("lfvs_uploader", { id: uploader.id }, { name: vInfo.uploader.name });
              uploaderNameUpdated = true;
            }
            try {
              await this.ctx.database.create("lfvs_video", {
                videoId: vInfo.videoId,
                platform: this.platform,
                title: vInfo.title,
                pic: vInfo.pic,
                pubdate: vInfo.pubdate,
                uploaderId: uploader.id,
                isSubscribed: true,
                nextUpdateAt: now,
                updateInterval: 300,
                currentView: 0,
                status: "active"
              });
              existingVideoIds.add(vInfo.videoId);
            } catch (e) {
              this.ctx.emit(
                "lfvs/log",
                this.logPrefix,
                "debug",
                `视频 ${vInfo.videoId} 已存在 (并发写入)，跳过`
              );
            }
          }
        }
        try {
          await this.sleep(500);
        } catch (error) {
          if (error.message === "Context disposed") break;
          throw error;
        }
      }
      if (uploaders.length > 0 && !this.abortController.signal.aborted) {
        this.ctx.emit("lfvs/schedule-round-end", this.platform, "uploader", uploaders.length, totalSuccess, totalFailure, Date.now() - roundStart);
      }
    } finally {
      this.isScanningUploaders = false;
    }
  }
};
var name = "lfvs-core";
var inject = ["database", "model", "logger"];
function apply(ctx) {
  ctx.model.extend("lfvs_uploader", {
    id: "unsigned",
    uid: "string",
    name: "string",
    platform: "string",
    isSubscribed: "boolean",
    status: { type: "string", initial: "active" }
  }, {
    autoInc: true,
    unique: [["platform", "uid"]]
  });
  ctx.model.extend("lfvs_video", {
    id: "unsigned",
    videoId: "string",
    platform: "string",
    title: "string",
    pic: "string",
    pubdate: "timestamp",
    isSubscribed: "boolean",
    nextUpdateAt: "timestamp",
    updateInterval: "integer",
    uploaderId: "unsigned",
    currentView: "unsigned",
    status: { type: "string", initial: "active" }
  }, {
    autoInc: true,
    unique: [["videoId", "platform"]]
  });
  ctx.model.extend("lfvs_video_stat", {
    id: "unsigned",
    videoId: "unsigned",
    timestamp: "timestamp",
    view: "unsigned",
    danmaku: "unsigned",
    reply: "unsigned",
    favorite: "unsigned",
    coin: "unsigned",
    share: "unsigned",
    like: "unsigned"
  }, {
    autoInc: true,
    foreign: {
      videoId: ["lfvs_video", "id"]
    }
  });
  ctx.model.extend("lfvs_milestone", {
    id: "unsigned",
    videoId: "unsigned",
    milestoneView: "unsigned",
    achievedAt: "timestamp"
  }, {
    autoInc: true
  });
  ctx.plugin(LfvsCoreService);
}
__name(apply, "apply");
export {
  APPROACHING_UPDATE_CONFIG,
  AbstractScheduleService,
  DETAILED_MILESTONES,
  LfvsCoreService,
  NORMAL_UPDATE_CONFIG,
  apply,
  inject,
  name
};

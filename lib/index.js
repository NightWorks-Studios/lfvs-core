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
  static inject = ["database"];
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
var name = "lfvs-core";
var inject = ["database", "model"];
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
    autoInc: true
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
  DETAILED_MILESTONES,
  LfvsCoreService,
  NORMAL_UPDATE_CONFIG,
  apply,
  inject,
  name
};

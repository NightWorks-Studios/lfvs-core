import { Context, Service } from 'cordis'
import {} from '@cordisjs/plugin-database'

export const DETAILED_MILESTONES = [
  100000, 200000, 300000, 400000, 500000, 600000, 700000, 800000, 900000,
  1000000, 2000000, 3000000, 4000000, 5000000, 6000000, 7000000, 8000000, 9000000,
  10000000, 20000000, 100000000
].sort((a, b) => a - b)

export const NORMAL_UPDATE_CONFIG = {
  MIN_INTERVAL_SECONDS: 20 * 60,
  MAX_INTERVAL_SECONDS: 4 * 60 * 60,
  DECAY_RATE: 0.05,
  JITTER_PERCENTAGE: 0.15,
}

export const APPROACHING_UPDATE_CONFIG = {
  MIN_INTERVAL_SECONDS: 75,
  MAX_INTERVAL_SECONDS: 10 * 60,
  DECAY_RATE: 0.3,
  JITTER_PERCENTAGE: 0.1,
  PROXIMITY_SENSITIVITY: 2.0,
}

export interface GenericVideoInfo {
  platform: string
  videoId: string
  title: string
  pic: string
  pubdate: Date
  uploader: {
    uid: string
    name: string
  }
}

export interface GenericVideoStat {
  view: number | null
  danmaku: number | null
  reply: number | null
  favorite: number | null
  coin: number | null
  share: number | null
  like: number | null
}

export type AdapterResult<T> = 
  | { status: 'success'; data: T }
  | { status: 'not_found'; message?: string }
  | { status: 'error'; message: string; retryable: boolean }

export interface LfvsAdapter {
  platform: string;
  getVideoInfoAndStats(videoId: string): Promise<AdapterResult<{ info: GenericVideoInfo; stat: GenericVideoStat }>>
  getUploaderRecentVideos(uid: string): Promise<AdapterResult<GenericVideoInfo[]>>
  getUploaderInfo(uid: string): Promise<AdapterResult<{ uid: string; name: string; avatar?: string }>>
  getCredentials(): any
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    lfvs_uploader: LfvsUploader
    lfvs_video: LfvsVideo
    lfvs_video_stat: LfvsVideoStat
    lfvs_milestone: LfvsMilestone
  }
}

declare module 'cordis' {
  interface Context {
    'lfvs.core': LfvsCoreService
  }
  
  interface Events {
    'lfvs/adapter-online'(platform: string): void
    'lfvs/adapter-offline'(platform: string, reason: string): void
    'lfvs/api-request'(platform: string, action: string, target: string, success: boolean, costMs: number, message?: string): void
    'lfvs/schedule-round-start'(platform: string, type: 'video' | 'uploader', dbCostMs: number, totalCount: number): void
    'lfvs/schedule-round-end'(platform: string, type: 'video' | 'uploader', totalCount: number, successCount: number, failureCount: number, costMs: number): void
    'lfvs/video-updated'(platform: string, videoId: string, status: 'success' | 'not_found' | 'error', costMs: number, oldStat?: GenericVideoStat, newStat?: GenericVideoStat): void
    'lfvs/milestone-reached'(video: LfvsVideo, milestone: number, newStat: LfvsVideoStat): void
    'lfvs/new-video-found'(video: LfvsVideo): void
    'lfvs/resource-deleted'(platform: string, type: 'video' | 'uploader', id: string): void
    'lfvs/log'(pluginName: string, level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: any[]): void
  }
}

export interface LfvsUploader {
  id: number
  uid: string
  name: string
  platform: string
  isSubscribed: boolean
  status: string // 'active' | 'deleted'
}

export interface LfvsVideo {
  id: number
  videoId: string
  platform: string
  title: string
  pic: string
  pubdate: Date
  isSubscribed: boolean
  nextUpdateAt: Date
  updateInterval: number
  uploaderId: number
  currentView: number
  status: string // 'active' | 'deleted'
}

export interface LfvsVideoStat {
  id: number
  videoId: number
  timestamp: Date
  view: number
  danmaku: number
  reply: number
  favorite: number
  coin: number
  share: number
  like: number
}

export interface LfvsMilestone {
  id: number
  videoId: number
  milestoneView: number
  achievedAt: Date
}

export class LfvsCoreService extends Service {
  static inject = ['database', 'logger']
  public adapters: Map<string, LfvsAdapter> = new Map()

  constructor(ctx: Context) {
    super(ctx, 'lfvs.core')
  }

  registerAdapter(adapter: LfvsAdapter) {
    this.adapters.set(adapter.platform, adapter)
  }

  unregisterAdapter(platform: string) {
    this.adapters.delete(platform)
  }

  getAdapter(platform: string): LfvsAdapter | undefined {
    return this.adapters.get(platform)
  }
}

export const name = 'lfvs-core'
export const inject = ['database', 'model', 'logger']

export function apply(ctx: Context) {
  ctx.model.extend('lfvs_uploader', {
    id: 'unsigned',
    uid: 'string',
    name: 'string',
    platform: 'string',
    isSubscribed: 'boolean',
    status: { type: 'string', initial: 'active' },
  }, {
    autoInc: true,
    unique: [['platform', 'uid']],
  })

  ctx.model.extend('lfvs_video', {
    id: 'unsigned',
    videoId: 'string',
    platform: 'string',
    title: 'string',
    pic: 'string',
    pubdate: 'timestamp',
    isSubscribed: 'boolean',
    nextUpdateAt: 'timestamp',
    updateInterval: 'integer',
    uploaderId: 'unsigned',
    currentView: 'unsigned',
    status: { type: 'string', initial: 'active' },
  }, {
    autoInc: true,
    unique: [['videoId', 'platform']],
  })

  ctx.model.extend('lfvs_video_stat', {
    id: 'unsigned',
    videoId: 'unsigned',
    timestamp: 'timestamp',
    view: 'unsigned',
    danmaku: 'unsigned',
    reply: 'unsigned',
    favorite: 'unsigned',
    coin: 'unsigned',
    share: 'unsigned',
    like: 'unsigned',
  }, {
    autoInc: true,
  })

  ctx.model.extend('lfvs_milestone', {
    id: 'unsigned',
    videoId: 'unsigned',
    milestoneView: 'unsigned',
    achievedAt: 'timestamp',
  }, {
    autoInc: true,
  })

  ctx.plugin(LfvsCoreService)
}

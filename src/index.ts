import { Context, Service } from 'cordis'
import {} from '@cordisjs/plugin-database'
import {} from '@cordisjs/plugin-timer'

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
    'lfvs/schedule-round-end'(platform: string, type: 'video' | 'uploader', totalCount: number, successCount: number, failureCount: number, unchangedCount: number, costMs: number): void
    'lfvs/video-updated'(platform: string, video: LfvsVideo, status: 'success' | 'not_found' | 'error', costMs: number, oldStat?: LfvsVideoStat, newStat?: LfvsVideoStat): void
    'lfvs/milestone-reached'(video: LfvsVideo, milestone: number, oldStat: LfvsVideoStat, newStat: LfvsVideoStat): void
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
  static inject = []
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

// ──────────────────────────────────────────────────
// Schedule 抽象基类
// ──────────────────────────────────────────────────

export interface ScheduleConfig {
  enablePolling: boolean
  queueScanInterval: number
  uploaderScanInterval: number
  normalMinInterval: number
  normalMaxInterval: number
  normalDecayRate: number
  approachingMinInterval: number
  approachingMaxInterval: number
  proximitySensitivity: number
  jitterPercentage: number
  maxVideoProcess: number
  maxUploaderProcess: number
}

export abstract class AbstractScheduleService extends Service {
  static inject = ['database', 'timer', 'lfvs.core', 'logger']

  protected abstract platform: string
  protected abstract logPrefix: string
  protected config: ScheduleConfig

  private isUpdatingVideos = false
  private isScanningUploaders = false
  private videoIntervalId?: () => void
  private uploaderIntervalId?: () => void
  private abortController: AbortController
  public lastRoundStats = { totalProcessed: 0, maxVideoProcess: 0, isRunning: false, currentProcessed: 0, currentTotal: 0, currentSuccess: 0, currentFailure: 0 }

  constructor(ctx: Context, serviceName: string, config: ScheduleConfig) {
    super(ctx, serviceName)
    this.config = config
    this.abortController = new AbortController()
    this.lastRoundStats.maxVideoProcess = config.maxVideoProcess

    Promise.resolve().then(() => this.start().catch(e => {
      this.ctx.emit('lfvs/log', this.logPrefix, 'error', `启动失败: ${e.message}`)
    }))
  }

  protected async start() {
    if (!this.config.enablePolling) return

    this.ctx.on('lfvs/adapter-online', (platform) => {
      if (platform === this.platform) {
        this.startPolling()
      }
    })

    this.ctx.on('lfvs/adapter-offline', (platform) => {
      if (platform === this.platform) {
        this.stopPolling()
      }
    })

    // If adapter is already online when schedule starts
    if (this.ctx.get('lfvs.core').getAdapter(this.platform)) {
      this.startPolling()
    }
  }

  protected sleep(ms: number) {
    return new Promise<void>((resolve, reject) => {
      if (this.abortController.signal.aborted) {
        return reject(new Error('Context disposed'))
      }

      const timer = setTimeout(() => {
        this.abortController.signal.removeEventListener('abort', abortHandler)
        resolve()
      }, ms)

      const abortHandler = () => {
        clearTimeout(timer)
        reject(new Error('Context disposed'))
      }

      this.abortController.signal.addEventListener('abort', abortHandler)
    })
  }

  private startPolling() {
    if (this.videoIntervalId) return
    // 重建已失效的 AbortController，确保适配器重连后轮询能恢复
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController()
    }
    this.videoIntervalId = this.ctx.timer.setInterval(() => this.updateVideos(), this.config.queueScanInterval)
    this.uploaderIntervalId = this.ctx.timer.setInterval(() => this.scanUploaders(), this.config.uploaderScanInterval)
    
    // 立即执行一次
    this.ctx.setTimeout(() => {
      this.updateVideos()
      this.scanUploaders()
    }, 1000)
  }

  private stopPolling() {
    this.abortController.abort()
    if (this.videoIntervalId) this.videoIntervalId()
    if (this.uploaderIntervalId) this.uploaderIntervalId()
    this.videoIntervalId = undefined
    this.uploaderIntervalId = undefined
  }

  private calculateHybridInterval(viewDelta: number, timeDeltaInMinutes: number, distanceToNextMilestone: number | null): number {
    const isApproaching = distanceToNextMilestone !== null
    const MIN_INTERVAL_SECONDS = isApproaching ? this.config.approachingMinInterval : this.config.normalMinInterval
    const MAX_INTERVAL_SECONDS = isApproaching ? this.config.approachingMaxInterval : this.config.normalMaxInterval
    const DECAY_RATE = this.config.normalDecayRate
    const JITTER_PERCENTAGE = this.config.jitterPercentage

    if (timeDeltaInMinutes <= 0) return MAX_INTERVAL_SECONDS
    
    const viewsPerMinute = viewDelta / timeDeltaInMinutes
    let baseInterval = MIN_INTERVAL_SECONDS + (MAX_INTERVAL_SECONDS - MIN_INTERVAL_SECONDS) * Math.exp(-DECAY_RATE * viewsPerMinute)

    if (isApproaching && distanceToNextMilestone > 0) {
      const proximityFactor = 1 - Math.exp(-this.config.proximitySensitivity * (distanceToNextMilestone / 100000))
      const proximityAdjustedInterval = MIN_INTERVAL_SECONDS + (baseInterval - MIN_INTERVAL_SECONDS) * proximityFactor
      baseInterval = proximityAdjustedInterval
    }

    const jitter = (Math.random() * 2 - 1) * baseInterval * JITTER_PERCENTAGE
    const finalInterval = baseInterval + jitter
    return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, finalInterval))
  }

  private async updateVideos() {
    if (this.isUpdatingVideos) return
    this.isUpdatingVideos = true
    this.lastRoundStats.isRunning = true

    const roundStart = Date.now()
    const windowMs = this.config.queueScanInterval
    const MAX_PROCESS = this.config.maxVideoProcess
    const MIN_INTERVAL_MS = windowMs / MAX_PROCESS

    let totalSuccess = 0
    let totalFailure = 0
    let totalUnchanged = 0
    let totalProcessed = 0

    try {
      const now = new Date()

      const dbStart = Date.now()
      const videosToUpdate = await this.ctx.database.get('lfvs_video', {
        isSubscribed: true,
        status: 'active',
        platform: this.platform,
        nextUpdateAt: { $lte: now }
      }, { limit: MAX_PROCESS, sort: { nextUpdateAt: 'asc' } })
      const dbCostMs = Date.now() - dbStart

      if (videosToUpdate.length === 0) return

      this.ctx.emit('lfvs/schedule-round-start', this.platform, 'video', dbCostMs, videosToUpdate.length)

      const intervalMs = Math.max(MIN_INTERVAL_MS, windowMs / videosToUpdate.length)
      totalProcessed = videosToUpdate.length
      this.lastRoundStats.currentTotal = videosToUpdate.length
      this.lastRoundStats.currentProcessed = 0
      this.lastRoundStats.currentSuccess = 0
      this.lastRoundStats.currentFailure = 0

      // 并发分发：按固定间隔逐个发射请求，不等待上一个完成
      const promises: Promise<string>[] = []

      for (const video of videosToUpdate) {
        if (this.abortController.signal.aborted) break

        const p = this.processSingleVideo(video).then((result) => {
          if (result === 'changed') { totalSuccess++; this.lastRoundStats.currentSuccess++ }
          else if (result === 'unchanged') { totalSuccess++; totalUnchanged++; this.lastRoundStats.currentSuccess++ }
          else { totalFailure++; this.lastRoundStats.currentFailure++ }
          this.lastRoundStats.currentProcessed++
          return result
        }).catch((error: any) => {
          if (error.message !== 'Context disposed') {
            totalFailure++
            this.ctx.emit('lfvs/log', this.logPrefix, 'error', `updateVideos 异常: ${error.message}`)
          }
          return 'error'
        })
        promises.push(p)

        // 仅等待发射间隔，不等待请求完成
        if (!this.abortController.signal.aborted) {
          try { await this.sleep(intervalMs) } catch { break }
        }
      }

      // 等待所有已发射的请求落地
      await Promise.allSettled(promises)

    } finally {
      this.isUpdatingVideos = false
      this.lastRoundStats.totalProcessed = totalProcessed
      this.lastRoundStats.isRunning = false
      this.lastRoundStats.currentProcessed = 0
      this.lastRoundStats.currentTotal = 0
      this.lastRoundStats.currentSuccess = 0
      this.lastRoundStats.currentFailure = 0
      if (totalProcessed > 0 && !this.abortController.signal.aborted) {
        this.ctx.emit('lfvs/schedule-round-end', this.platform, 'video', totalProcessed, totalSuccess, totalFailure, totalUnchanged, Date.now() - roundStart)
      }
    }
  }

  private async processSingleVideo(video: LfvsVideo): Promise<'changed' | 'unchanged' | 'error'> {
    const adapter = this.ctx.get('lfvs.core').getAdapter(this.platform)
    if (!adapter) return 'error'
    
    const now = new Date()
    const start = Date.now()
    
    try {
      const res = await adapter.getVideoInfoAndStats(video.videoId)
      const costMs = Date.now() - start
      
      if (res.status === 'not_found') {
        await this.ctx.database.set('lfvs_video', { id: video.id }, {
          status: 'deleted',
          isSubscribed: false
        })
        this.ctx.emit('lfvs/resource-deleted', this.platform, 'video', video.videoId)
        this.ctx.emit('lfvs/video-updated', this.platform, video, 'not_found', costMs)
        return 'changed'
      }

      if (res.status === 'error') {
        const retryDelaySeconds = 20 * 60
        await this.ctx.database.set('lfvs_video', { id: video.id }, {
          nextUpdateAt: new Date(Date.now() + retryDelaySeconds * 1000)
        })
        this.ctx.emit('lfvs/video-updated', this.platform, video, 'error', costMs)
        return 'error'
      }

      const { stat: newStat, info } = res.data
      
      // Auto-Heal Mechanism
      let videoUploaderId = video.uploaderId
      let needsMetadataUpdate = false
      if (info && (!videoUploaderId || !video.title || !video.pic || !video.pubdate)) {
        if (!videoUploaderId && info.uploader) {
          const upCheck = await this.ctx.database.get('lfvs_uploader', { 
            uid: info.uploader.uid, 
            platform: this.platform 
          }, ['id'])
          
          if (upCheck.length > 0) {
            videoUploaderId = upCheck[0].id
          } else {
            try {
              const createdUp = await this.ctx.database.create('lfvs_uploader', {
                uid: info.uploader.uid,
                name: info.uploader.name,
                platform: this.platform,
                isSubscribed: false,
                status: 'active'
              })
              videoUploaderId = createdUp.id
            } catch {
              // 并发写入导致唯一约束冲突，回退查询已存在的记录
              const fallback = await this.ctx.database.get('lfvs_uploader', {
                uid: info.uploader.uid,
                platform: this.platform
              }, ['id'])
              if (fallback.length > 0) videoUploaderId = fallback[0].id
            }
          }
        }
        needsMetadataUpdate = true
      }
      
      const latestStats = await this.ctx.database.get('lfvs_video_stat', { videoId: video.id }, {
        sort: { timestamp: 'desc' },
        limit: 1
      })
      const latestStat = latestStats[0]

      let dataHasChanged = true
      if (latestStat) {
        const n = (v: number | null | undefined) => v ?? 0
        if (
          n(newStat.view) === latestStat.view && n(newStat.danmaku) === latestStat.danmaku &&
          n(newStat.reply) === latestStat.reply && n(newStat.favorite) === latestStat.favorite &&
          n(newStat.coin) === latestStat.coin && n(newStat.share) === latestStat.share &&
          n(newStat.like) === latestStat.like
        ) {
          dataHasChanged = false
        }
      }

      const milestonesToCreate: any[] = []

      if (dataHasChanged && latestStat) {
        const milestonesCrossed = DETAILED_MILESTONES.filter(m => latestStat.view < m && (newStat.view || 0) >= m)
        if (milestonesCrossed.length > 0) {
          const fullStat: LfvsVideoStat = { 
            id: 0, videoId: video.id, timestamp: now, 
            view: newStat.view || 0,
            danmaku: newStat.danmaku || 0,
            reply: newStat.reply || 0,
            favorite: newStat.favorite || 0,
            coin: newStat.coin || 0,
            share: newStat.share || 0,
            like: newStat.like || 0
          }
          for (const milestone of milestonesCrossed) {
            milestonesToCreate.push({ videoId: video.id, milestoneView: milestone, achievedAt: now })
            this.ctx.emit('lfvs/milestone-reached', video as LfvsVideo, milestone, latestStat, fullStat)
          }
        }
      }

      let newInterval: number
      let distance: number | null = null
      const nextMilestone = DETAILED_MILESTONES.find(m => m > (newStat.view || 0))
      
      if (nextMilestone && (newStat.view || 0) >= nextMilestone * 0.9) {
        distance = nextMilestone - (newStat.view || 0)
      }

      if (latestStat) {
        const viewDelta = dataHasChanged ? (newStat.view || 0) - latestStat.view : 0
        const timeDelta = (now.getTime() - latestStat.timestamp.getTime()) / (1000 * 60)
        newInterval = this.calculateHybridInterval(viewDelta, timeDelta, distance)
      } else {
        newInterval = 300 // 第一次扫描到后下一次扫描时间固定为5分钟
        this.ctx.emit('lfvs/new-video-found', video as LfvsVideo)
      }

      const nextUpdateAt = new Date(Date.now() + newInterval * 1000)

      if (dataHasChanged) {
        await this.ctx.database.create('lfvs_video_stat', { 
          videoId: video.id, timestamp: now,
          view: newStat.view || 0,
          danmaku: newStat.danmaku || 0,
          reply: newStat.reply || 0,
          favorite: newStat.favorite || 0,
          coin: newStat.coin || 0,
          share: newStat.share || 0,
          like: newStat.like || 0
        })
        if (milestonesToCreate.length > 0) {
          await this.ctx.database.upsert('lfvs_milestone', milestonesToCreate)
        }
      } else if (latestStat) {
        await this.ctx.database.set('lfvs_video_stat', { id: latestStat.id }, { timestamp: now })
      }

      const updatePayload: any = {
        updateInterval: Math.round(newInterval),
        nextUpdateAt: nextUpdateAt,
        title: info.title,
        pic: info.pic,
        currentView: newStat.view || 0
      }
      
      if (needsMetadataUpdate) {
        if (videoUploaderId) updatePayload.uploaderId = videoUploaderId
        if (info.pubdate) updatePayload.pubdate = info.pubdate
      }

      await this.ctx.database.set('lfvs_video', { id: video.id }, updatePayload)

      const fullNewStat: LfvsVideoStat = { id: 0, videoId: video.id, timestamp: now, view: newStat.view||0, danmaku: newStat.danmaku||0, reply: newStat.reply||0, favorite: newStat.favorite||0, coin: newStat.coin||0, share: newStat.share||0, like: newStat.like||0 }
      this.ctx.emit('lfvs/video-updated', this.platform, video, 'success', costMs, latestStat as any, fullNewStat)
      return dataHasChanged ? 'changed' : 'unchanged'
    } catch (error: any) {
      this.ctx.emit('lfvs/log', this.logPrefix, 'error',
        `processSingleVideo 异常 [${video.videoId}]: ${error.message}`, error.stack)
      return 'error'
    }
  }

  private async scanUploaders() {
    if (this.isScanningUploaders) return
    this.isScanningUploaders = true

    const roundStart = Date.now()
    const adapter = this.ctx.get('lfvs.core').getAdapter(this.platform)
    if (!adapter) {
      this.isScanningUploaders = false
      return
    }

    try {
      const dbStart = Date.now()
      const uploaders = await this.ctx.database.get('lfvs_uploader', {
        isSubscribed: true,
        status: 'active',
        platform: this.platform
      }, { limit: this.config.maxUploaderProcess, sort: { id: 'asc' } })
      const dbCostMs = Date.now() - dbStart

      if (uploaders.length > 0) {
        this.ctx.emit('lfvs/schedule-round-start', this.platform, 'uploader', dbCostMs, uploaders.length)
      }

      let totalSuccess = 0
      let totalFailure = 0

      for (const uploader of uploaders) {
        if (this.abortController.signal.aborted) break
        const res = await adapter.getUploaderRecentVideos(uploader.uid)
        
        if (res.status === 'not_found') {
          await this.ctx.database.set('lfvs_uploader', { id: uploader.id }, { status: 'deleted', isSubscribed: false })
          this.ctx.emit('lfvs/resource-deleted', this.platform, 'uploader', uploader.uid)
          totalSuccess++
          continue
        } else if (res.status === 'error') {
          totalFailure++
          continue
        }

        totalSuccess++
        const recentVideos = res.data
        if (recentVideos.length === 0) continue

        // 优化: 一次性查询当前 UP 主在这个平台下的所有已有视频，避免在循环中重复查询
        const videoIds = recentVideos.map(v => v.videoId)
        const existingVideosDb = await this.ctx.database.get('lfvs_video', { 
          videoId: videoIds, 
          platform: this.platform 
        }, ['videoId'])
        const existingVideoIds = new Set(existingVideosDb.map(v => v.videoId))

        let uploaderNameUpdated = false
        const now = new Date()

        for (const vInfo of recentVideos) {
          if (!existingVideoIds.has(vInfo.videoId)) {
            // 只在发现新视频且未更新过名字时，更新一次 UP 主名字
            if (!uploaderNameUpdated && uploader.name !== vInfo.uploader.name) {
              await this.ctx.database.set('lfvs_uploader', { id: uploader.id }, { name: vInfo.uploader.name })
              uploaderNameUpdated = true
            }
            
            try {
              await this.ctx.database.create('lfvs_video', {
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
                status: 'active'
              })
              existingVideoIds.add(vInfo.videoId)
            } catch (e: any) {
              // 唯一约束冲突 — 其他进程/插件已创建该视频，可安全跳过
              this.ctx.emit('lfvs/log', this.logPrefix, 'debug',
                `视频 ${vInfo.videoId} 已存在 (并发写入)，跳过`)
            }
          }
        }
        try {
          await this.sleep(500)
        } catch (error: any) {
          if (error.message === 'Context disposed') break
          throw error
        }
      }

      if (uploaders.length > 0 && !this.abortController.signal.aborted) {
        this.ctx.emit('lfvs/schedule-round-end', this.platform, 'uploader', uploaders.length, totalSuccess, totalFailure, 0, Date.now() - roundStart)
      }
    } finally {
      this.isScanningUploaders = false
    }
  }
}

// ──────────────────────────────────────────────────
// Plugin apply & model definitions
// ──────────────────────────────────────────────────

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
    indexes: [['platform', 'status', 'isSubscribed', 'nextUpdateAt']],
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
    foreign: {
      videoId: ['lfvs_video', 'id'],
    },
    indexes: [['videoId', 'timestamp']],
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

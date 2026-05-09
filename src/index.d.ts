import { Context, Service } from 'cordis';
export declare const DETAILED_MILESTONES: number[];
export declare const NORMAL_UPDATE_CONFIG: {
    MIN_INTERVAL_SECONDS: number;
    MAX_INTERVAL_SECONDS: number;
    DECAY_RATE: number;
    JITTER_PERCENTAGE: number;
};
export declare const APPROACHING_UPDATE_CONFIG: {
    MIN_INTERVAL_SECONDS: number;
    MAX_INTERVAL_SECONDS: number;
    DECAY_RATE: number;
    JITTER_PERCENTAGE: number;
    PROXIMITY_SENSITIVITY: number;
};
export interface GenericVideoInfo {
    platform: string;
    videoId: string;
    title: string;
    pic: string;
    pubdate: Date;
    uploader: {
        uid: string;
        name: string;
    };
}
export interface GenericVideoStat {
    view: number | null;
    danmaku: number | null;
    reply: number | null;
    favorite: number | null;
    coin: number | null;
    share: number | null;
    like: number | null;
}
export type AdapterResult<T> = {
    status: 'success';
    data: T;
} | {
    status: 'not_found';
    message?: string;
} | {
    status: 'error';
    message: string;
    retryable: boolean;
};
export interface LfvsAdapter {
    platform: string;
    getVideoInfoAndStats(videoId: string): Promise<AdapterResult<{
        info: GenericVideoInfo;
        stat: GenericVideoStat;
    }>>;
    getUploaderRecentVideos(uid: string): Promise<AdapterResult<GenericVideoInfo[]>>;
    getUploaderInfo(uid: string): Promise<AdapterResult<{
        uid: string;
        name: string;
        avatar?: string;
    }>>;
    getCredentials(): any;
}
declare module '@cordisjs/plugin-database' {
    interface Tables {
        lfvs_uploader: LfvsUploader;
        lfvs_video: LfvsVideo;
        lfvs_video_stat: LfvsVideoStat;
        lfvs_milestone: LfvsMilestone;
    }
}
declare module 'cordis' {
    interface Context {
        'lfvs.core': LfvsCoreService;
    }
    interface Events {
        'lfvs/adapter-online'(platform: string): void;
        'lfvs/adapter-offline'(platform: string, reason: string): void;
        'lfvs/api-request'(platform: string, action: string, target: string, success: boolean, costMs: number, message?: string): void;
        'lfvs/schedule-round-start'(platform: string, type: 'video' | 'uploader', dbCostMs: number, totalCount: number): void;
        'lfvs/schedule-round-end'(platform: string, type: 'video' | 'uploader', totalCount: number, successCount: number, failureCount: number, unchangedCount: number, costMs: number): void;
        'lfvs/video-updated'(platform: string, video: LfvsVideo, status: 'success' | 'not_found' | 'error', costMs: number, oldStat?: LfvsVideoStat, newStat?: LfvsVideoStat): void;
        'lfvs/milestone-reached'(video: LfvsVideo, milestone: number, oldStat: LfvsVideoStat, newStat: LfvsVideoStat): void;
        'lfvs/new-video-found'(video: LfvsVideo): void;
        'lfvs/resource-deleted'(platform: string, type: 'video' | 'uploader', id: string): void;
        'lfvs/log'(pluginName: string, level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: any[]): void;
    }
}
export interface LfvsUploader {
    id: number;
    uid: string;
    name: string;
    platform: string;
    isSubscribed: boolean;
    status: string;
}
export interface LfvsVideo {
    id: number;
    videoId: string;
    platform: string;
    title: string;
    pic: string;
    pubdate: Date;
    isSubscribed: boolean;
    nextUpdateAt: Date;
    updateInterval: number;
    uploaderId: number;
    currentView: number;
    status: string;
}
export interface LfvsVideoStat {
    id: number;
    videoId: number;
    timestamp: Date;
    view: number;
    danmaku: number;
    reply: number;
    favorite: number;
    coin: number;
    share: number;
    like: number;
}
export interface LfvsMilestone {
    id: number;
    videoId: number;
    milestoneView: number;
    achievedAt: Date;
}
export declare class LfvsCoreService extends Service {
    static inject: string[];
    adapters: Map<string, LfvsAdapter>;
    constructor(ctx: Context);
    registerAdapter(adapter: LfvsAdapter): void;
    unregisterAdapter(platform: string): void;
    getAdapter(platform: string): LfvsAdapter | undefined;
}
export declare const name = "lfvs-core";
export declare const inject: string[];
export declare function apply(ctx: Context): void;

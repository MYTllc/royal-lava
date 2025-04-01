class Constants {
    static LAVA_OP_CODES = {
        READY: 'ready',
        PLAYER_UPDATE: 'playerUpdate',
        STATS: 'stats',
        EVENT: 'event',
    };

    static LAVA_EVENT_TYPES = {
        TRACK_START: 'TrackStartEvent',
        TRACK_END: 'TrackEndEvent',
        TRACK_EXCEPTION: 'TrackExceptionEvent',
        TRACK_STUCK: 'TrackStuckEvent',
        WEBSOCKET_CLOSED: 'WebSocketClosedEvent',
    };

    static CLIENT_EVENT_TYPES = {
        NODE_CONNECT: 'nodeConnect',
        NODE_READY: 'nodeReady',
        NODE_DISCONNECT: 'nodeDisconnect',
        NODE_ERROR: 'nodeError',
        NODE_STATS: 'nodeStats',
        PLAYER_CREATE: 'playerCreate',
        PLAYER_DESTROY: 'playerDestroy',
        PLAYER_MOVE: 'playerMove',
        PLAYER_STATE_UPDATE: 'playerStateUpdate',
        PLAYER_WEBSOCKET_CLOSED: 'playerWebsocketClosed',
        QUEUE_END: 'queueEnd',
        TRACK_START: 'trackStart',
        TRACK_END: 'trackEnd',
        TRACK_EXCEPTION: 'trackException',
        TRACK_STUCK: 'trackStuck',
        DEBUG: 'debug'
    };

    static PLAYER_STATE = {
        INSTANTIATED: 'INSTANTIATED',
        PLAYING: 'PLAYING',
        PAUSED: 'PAUSED',
        STOPPED: 'STOPPED',
        DESTROYED: 'DESTROYED'
    };

    static LOOP_MODE = {
        NONE: 0,
        TRACK: 1,
        QUEUE: 2
    };

    static DEFAULT_RECONNECT_OPTIONS = {
        maxTries: 10,
        initialDelay: 1000, // 1 second
        maxDelay: 30000    // 30 seconds
    };

    static DEFAULT_NODE_OPTIONS = {
        port: 2333,
        password: "youshallnotpass",
        secure: false,
        identifier: `advanced-lavalink-v4-${process.pid}`,
        resumeKey: null,
        resumeTimeout: 60, // seconds
        reconnect: this.DEFAULT_RECONNECT_OPTIONS,
        retryAmount: 5 // Rest Retry Amount
    }

     static DEFAULT_PLAYER_OPTIONS = {
        initialVolume: 100,
        selfDeaf: true,
        selfMute: false,
    }
}

module.exports = Constants;

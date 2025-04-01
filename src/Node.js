const WebSocket = require('ws');
const EventEmitter = require('events');
const Rest = require('./Rest');
const Constants = require('./Constants');

class Node extends EventEmitter {
    constructor(manager, options = {}) {
        super();
        this.manager = manager;
        this.options = { ...Constants.DEFAULT_NODE_OPTIONS, ...options };
        if (!this.options.host) throw new Error("Node requires a host option.");
        this.identifier = this.options.identifier;
        this.stats = null;
        this.connected = false;
        this.ws = null;
        this.resumeKey = this.options.resumeKey;
        this.resumeTimeout = this.options.resumeTimeout;
        this.sessionId = null; // Lavalink Session ID
        this.rest = new Rest(this);
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.players = new Map(); // Players associated with this node
        this.WebSocket = WebSocket; // Expose WebSocket class if needed externally
        this._connect();
    }

    get Penalties() {
        if (!this.connected || !this.stats) return Infinity; // Heavily penalize disconnected nodes

        let penalty = 0;
        penalty += this.stats.players; // Player count
        penalty += Math.round(Math.pow(1.05, 100 * this.stats.cpu.systemLoad / (this.stats.cpu.cores || 1)) * 10 - 10); // CPU Load

        if (this.stats.memory?.used) {
             penalty += Math.round(this.stats.memory.used / 1024 / 1024); // Memory Usage in MB
        }

        if (this.stats.frameStats) {
            penalty += (this.stats.frameStats.deficit / 3000); // Frame deficit
            penalty += (this.stats.frameStats.nulled / 3000 * 2); // Penalize nulled frames more
        }
        return penalty;
    }


     _connect() {
         if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Already connected or connecting.`);
            return;
         }

         clearTimeout(this.reconnectTimer);
         this.reconnectTimer = null;

        const headers = {
            'Authorization': this.options.password,
            'User-Id': this.manager.userId,
            'Client-Name': `advanced-lavalink-v4/${this.manager.userId}` // Include UserID for better identification server-side
        };

        if (this.sessionId) {
            headers['Session-Id'] = this.sessionId;
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Attempting to resume session ${this.sessionId}`);
         } else if (this.resumeKey) {
             headers['Resume-Key'] = this.resumeKey;
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Attempting to connect with resume key ${this.resumeKey}`);
        }

        const wsUrl = `ws${this.options.secure ? 's' : ''}://${this.options.host}:${this.options.port}/v4/websocket`;
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Connecting to ${wsUrl}`);
         this.ws = new WebSocket(wsUrl, { headers });

        this.ws.on('open', this._handleOpen.bind(this));
        this.ws.on('message', this._handleMessage.bind(this));
        this.ws.on('close', this._handleClose.bind(this));
        this.ws.on('error', this._handleError.bind(this));
    }

     _handleOpen() {
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_CONNECT, this);
         this.connected = true;
         this.reconnectAttempt = 0; // Reset on successful connect/reconnect
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;

         if (this.resumeKey && !this.sessionId) { // Configure resumption if using key but not currently resuming a session
            this.rest.updateSession(null, this.resumeTimeout)
                 .then(() => this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Session resumption configured (Timeout: ${this.resumeTimeout}s)`))
                .catch(err => this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, new Error(`Failed to configure session resumption: ${err.message}`)));
        } else if (this.sessionId) {
             // Resuming. Lavalink should send player states if successful.
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] WebSocket open, waiting for Lavalink's response on session ${this.sessionId}`);
             // We don't call nodeReady immediately on resume, wait for 'ready' payload
        } else {
            // Fresh connection, ready isn't strictly needed but nice for flow
            // this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_READY, this); // Wait for 'ready' op
        }
    }

     _handleMessage(payload) {
         const rawData = payload;
        payload = JSON.parse(payload);
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Received Payload: ${payload.op}`);


        switch (payload.op) {
            case Constants.LAVA_OP_CODES.READY:
                this.sessionId = payload.sessionId;
                 this.rest.setSessionId(this.sessionId);
                 this.connected = true; // Ensure connected is true after receiving ready
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Received Ready. Session ID: ${this.sessionId}, Resumed: ${payload.resumed}`);

                 if (!payload.resumed) { // Only configure resume if it's a NEW session
                    if (this.resumeKey) {
                        this.rest.updateSession(null, this.resumeTimeout)
                         .then(() => this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Session resumption configured on new session (Timeout: ${this.resumeTimeout}s)`))
                        .catch(err => this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, new Error(`Failed to configure session resumption on new session: ${err.message}`)));
                     }
                 }
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_READY, this);
                 this.reconnectAttempt = 0; // Successfully connected/resumed
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
                break;

            case Constants.LAVA_OP_CODES.STATS:
                this.stats = payload;
                 delete this.stats.op; // Remove op code from stats object
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_STATS, this, this.stats);
                break;

            case Constants.LAVA_OP_CODES.PLAYER_UPDATE:
                const playerUpdate = this.manager.players.get(payload.guildId);
                if (playerUpdate) {
                     playerUpdate._updateState(payload.state);
                } else {
                     this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Received player update for unknown player ${payload.guildId}`);
                 }
                break;

             case Constants.LAVA_OP_CODES.EVENT:
                const playerEvent = this.manager.players.get(payload.guildId);
                 if (playerEvent) {
                    playerEvent._handleEvent(payload);
                 } else {
                    this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Received event for unknown player ${payload.guildId}`);
                 }
                break;
            default:
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Received unknown op code: ${payload.op || 'UnknownOp'}`, rawData.toString());
        }
    }

     _handleClose(code, reason) {
        this.ws?.removeAllListeners(); // Clean up listeners to prevent leaks
        this.ws = null;
         this.connected = false;
        this.sessionId = null; // Session is lost on disconnect unless explicitly resuming later
        this.rest.setSessionId(null); // Clear REST session ID too

        let reasonStr = reason?.toString() || 'No reason provided';
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_DISCONNECT, this, code, reasonStr);

        // Standard disconnect codes don't usually warrant auto-reconnect attempts unless forced
         // 1000 = Normal Closure, 1001 = Going Away, 1005 = No Status Recvd (might be ok)
         // 4xxx codes are application specific (Lavalink) - Treat most as needing reconnect potentially
         const normalCodes = [1000, 1001, 1005];
        const permanentErrorCodes = [4004, 4005, 4006, 4009, 4015, 4016]; // Codes indicating configuration issues or permanent errors

        if (permanentErrorCodes.includes(code)) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, new Error(`Permanent error on close: ${code} - ${reasonStr}. Disabling reconnect. Check credentials/config.`));
             // Consider automatically removing the node or marking it as unusable
             return; // Don't attempt reconnect for these errors
        }

        if (!this.reconnectTimer && (this.options.reconnect && (!normalCodes.includes(code) || this.manager.explicitDisconnect !== this))) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] WebSocket closed (${code}: ${reasonStr}). Attempting reconnect.`);
            this._attemptReconnect();
         } else if (this.manager.explicitDisconnect === this) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] WebSocket closed normally after explicit disconnect request.`);
             this.manager.explicitDisconnect = null; // Reset flag
         } else {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] WebSocket closed (${code}: ${reasonStr}). Reconnect disabled or already in progress.`);
         }

         // Try to move players if disconnect was unexpected
        if (!normalCodes.includes(code)) {
             this.manager._handleNodeDisconnection(this);
        }
    }

     _handleError(error) {
        // If an error occurs BEFORE the connection closes, it might signify a problem that leads to a close.
         // The 'close' event will likely follow, triggering reconnection logic.
        // If it's an error after connection, it's less common but could happen.
        const msg = error.message || 'Unknown WebSocket Error';
         this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, error, `Error: ${msg}`);
        // Don't explicitly trigger reconnect here, let the 'close' event handle it if it follows
         // Exception: Handle specific connection errors immediately
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND'){
             if(this.connected) this.disconnect(1006, `Connection error: ${error.code}`); // Force close if already connected
             else this._attemptReconnect(); // Attempt reconnect if it happened during initial connection attempt
        }

    }

     _attemptReconnect() {
        if (this.reconnectTimer) return; // Already scheduled

        if (this.reconnectAttempt >= this.options.reconnect.maxTries) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, new Error(`Max reconnect attempts reached (${this.options.reconnect.maxTries}) for node ${this.identifier}. Giving up.`));
            this.disconnect(1000, "Reconnect attempts exhausted"); // Cleanly disconnect if possible
             this.manager._handleNodeDisconnection(this, true); // Mark as failed permanently
            return;
        }

        const delay = Math.min(
            this.options.reconnect.initialDelay * Math.pow(2, this.reconnectAttempt),
            this.options.reconnect.maxDelay
        );

        this.reconnectAttempt++;
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Scheduling reconnect attempt ${this.reconnectAttempt}/${this.options.reconnect.maxTries} in ${delay}ms.`);

        this.reconnectTimer = setTimeout(() => {
             this.sessionId = this.resumeKey ? this.sessionId : null; // Keep session ID only if we have a resume key enabled
             this.reconnectTimer = null; // Clear timer before attempting connect
             this._connect();
        }, delay);
    }


     /**
      * Use REST to update player state on Lavalink
      * @param {string} guildId
      * @param {object} data Payload for the updatePlayer endpoint
      * @param {boolean} [noReplace=false] Lavalink option for track playing
      * @returns {Promise<object>} The player state from Lavalink
      */
     updatePlayer(guildId, data = {}, noReplace = false) {
        return this.rest.updatePlayer(guildId, { ...data, noReplace });
     }

    /**
     * Use REST to destroy player on Lavalink
     * @param {string} guildId
     * @returns {Promise<void>}
     */
     destroyPlayer(guildId) {
        return this.rest.destroyPlayer(guildId);
    }

    send(payload) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('WebSocket not open.'));
            }
            const data = JSON.stringify(payload);
            this.ws.send(data, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }


     configureResuming(key = this.resumeKey, timeout = this.resumeTimeout) {
        if (key) this.resumeKey = key;
         if (timeout) this.resumeTimeout = timeout;
         if (!this.sessionId) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Cannot configure resuming yet, no session ID established.`);
             return Promise.resolve(); // Cannot update session without an ID yet
         }
        return this.rest.updateSession(null, this.resumeTimeout); // Note: 'resuming' patch is only for forcing resume state, not configuring the key itself
    }


    disconnect(code = 1000, reason = "Client initiated disconnect") {
         clearTimeout(this.reconnectTimer);
         this.reconnectTimer = null;
        this.connected = false;
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.manager.explicitDisconnect = this; // Mark that *we* initiated this close
                 this.ws.close(code, reason);
            } else if (this.ws.readyState === WebSocket.CONNECTING) {
                 // If connecting, terminate immediately. The close event might still fire.
                 this.ws.terminate();
                 this.ws = null; // Ensure WS is nullified if terminated during connection
                 // Manually trigger the disconnected state logic if terminating a connecting socket
                 this._handleClose(code, `${reason} (terminated during connect)`);
             } else {
                 this.ws = null; // Already closed or closing
             }
         } else {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Disconnect called but WebSocket was already null.`);
         }
        // Clear session details immediately upon explicit disconnect request
         this.sessionId = null;
         this.rest.setSessionId(null);
    }

    destroy() {
        this.disconnect();
         // Remove players associated specifically with this node instance if needed
        this.players.clear(); // Player instances belong to Manager, but we clear node's reference
         this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Node destroyed.`);
         this.removeAllListeners(); // Clean up node event listeners
    }

     _addPlayer(player) {
         this.players.set(player.guildId, player);
     }

     _removePlayer(player) {
        this.players.delete(player.guildId);
     }
}

module.exports = Node;

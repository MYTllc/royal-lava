// src/Node.js

// --- Original Dependencies (No Change) ---
const WebSocket = require('ws');
const EventEmitter = require('events');
const Rest = require('./Rest');
const Constants = require('./Constants');
// --- End Original Dependencies ---

class Node extends EventEmitter {
    constructor(manager, options = {}) {
        super();
        this.manager = manager;
        this.options = { ...Constants.DEFAULT_NODE_OPTIONS, ...options };
        if (!this.options.host) throw new Error("Node requires a host option.");
        this.identifier = this.options.identifier;
        this.stats = null;
        this.connected = false; // Will be true ONLY after READY payload is received
        this.ws = null;
        this.resumeKey = this.options.resumeKey;
        this.resumeTimeout = this.options.resumeTimeout;
        this.sessionId = null; // Lavalink Session ID
        this.rest = new Rest(this);
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.players = new Map();
        this.WebSocket = WebSocket;
        this._connect(); // Initial connection attempt
    }

    get Penalties() {
        if (!this.connected || !this.stats) return Infinity;

        let penalty = 0;
        penalty += this.stats.players;
        penalty += Math.round(Math.pow(1.05, 100 * this.stats.cpu.systemLoad / (this.stats.cpu.cores || 1)) * 10 - 10);
        if (this.stats.memory?.used) {
             penalty += Math.round(this.stats.memory.used / 1024 / 1024);
        }
        if (this.stats.frameStats) {
            penalty += (this.stats.frameStats.deficit / 3000);
            penalty += (this.stats.frameStats.nulled / 3000 * 2);
        }
        return penalty;
    }


    _connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Already connected or connecting.`);
            return;
        }
        if (!this.manager.userId) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Cannot connect yet, Manager userId not set. Will retry on next attempt if applicable.`);
            // Do not schedule immediate reconnect here, rely on external trigger or existing reconnect timer
            return;
        }


         clearTimeout(this.reconnectTimer);
         this.reconnectTimer = null;

        const headers = {
            'Authorization': this.options.password,
            'User-Id': this.manager.userId, // Manager userId IS required now
            'Client-Name': `royal-lava/${this.manager.userId}` // Use actual package name?
        };

        if (this.sessionId) { // Resuming a specific session ID
            headers['Session-Id'] = this.sessionId;
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Attempting to resume session ${this.sessionId}`);
        } else if (this.resumeKey) { // Fresh connect but indicating willingness to resume using key
            headers['Resume-Key'] = this.resumeKey;
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Attempting to connect with resume key ${this.resumeKey}`);
        }

        const wsUrl = `ws${this.options.secure ? 's' : ''}://${this.options.host}:${this.options.port}/v4/websocket`;
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Connecting to ${wsUrl}`);
        try {
             this.ws = new WebSocket(wsUrl, { headers });
        } catch (err) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, err, 'WebSocket instantiation failed');
            this._attemptReconnect(); // Attempt reconnect on instantiation failure
             return;
         }


        this.ws.on('open', this._handleOpen.bind(this));
        this.ws.on('message', this._handleMessage.bind(this));
        this.ws.on('close', this._handleClose.bind(this));
        this.ws.on('error', this._handleError.bind(this));
    }

    _handleOpen() {
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_CONNECT, this);
        // DO NOT set `this.connected = true` here. Wait for READY payload.
        this.reconnectAttempt = 0;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;

        // --- OLD CODE: Attempting premature session config ---
        /*
        if (this.resumeKey && !this.sessionId) { // Configure resumption if using key but not currently resuming a session
            this.rest.updateSession(null, this.resumeTimeout)
                 .then(() => this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Attempted session resumption configuration (Timeout: ${this.resumeTimeout}s)`))
                .catch(err => this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, new Error(`Failed to configure session resumption (expected if session ID not ready): ${err.message}`)));
        }
        */
        // --- END OLD CODE ---

        if (this.sessionId) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] WebSocket open, waiting for Lavalink's response on session ${this.sessionId}`);
        } else {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] WebSocket open, awaiting Ready payload.`);
        }
    }

    _handleMessage(payloadData) {
         let payload;
        try {
             payload = JSON.parse(payloadData);
         } catch (e) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, e, 'Failed to parse incoming WebSocket message');
             return;
         }
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Received Payload OP: ${payload.op}`);

        switch (payload.op) {
            case Constants.LAVA_OP_CODES.READY:
                this.sessionId = payload.sessionId;
                 this.rest.setSessionId(this.sessionId);
                // --- MODIFIED CODE: Set connected = true ONLY here ---
                this.connected = true;
                // --- END MODIFIED CODE ---
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Received Ready. Session ID: ${this.sessionId}, Resumed: ${payload.resumed}`);

                 // --- NEW CODE: Configure resumption ONLY AFTER receiving ready if it's a NEW session ---
                if (!payload.resumed && this.resumeKey) {
                     this.configureResuming(this.resumeKey, this.resumeTimeout)
                         .catch(err => this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, new Error(`Failed to configure session resumption post-ready: ${err.message}`)));
                 }
                // --- END NEW CODE ---

                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_READY, this); // Emit ready AFTER setting state
                 this.reconnectAttempt = 0;
                 clearTimeout(this.reconnectTimer);
                 this.reconnectTimer = null;
                break;

            case Constants.LAVA_OP_CODES.STATS:
                this.stats = payload;
                delete this.stats.op;
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_STATS, this, this.stats);
                break;

            case Constants.LAVA_OP_CODES.PLAYER_UPDATE:
                const playerUpdate = this.players.get(payload.guildId); // Use node's player map
                if (playerUpdate) {
                    playerUpdate._updateState(payload.state);
                }
                break;

             case Constants.LAVA_OP_CODES.EVENT:
                const playerEvent = this.players.get(payload.guildId); // Use node's player map
                if (playerEvent) {
                   playerEvent._handleEvent(payload);
                }
                break;
            default:
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Received unknown op code: ${payload.op}`, payloadData.toString());
        }
    }

    _handleClose(code, reasonBuffer) {
         // --- MODIFIED CODE: Convert reason buffer to string safely ---
        const reason = reasonBuffer ? reasonBuffer.toString() : 'No reason provided';
         this.ws?.removeAllListeners(); // Clean up listeners
        this.ws = null; // Nullify WebSocket object
         this.connected = false; // Mark as disconnected
        // --- END MODIFIED CODE ---

         // Keep sessionId only if resumeKey is set, allowing potential future resumption
         if (!this.resumeKey) {
            this.sessionId = null;
             this.rest.setSessionId(null);
         } else {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] WebSocket closed, but keeping sessionId ${this.sessionId} due to resumeKey.`);
         }

        this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_DISCONNECT, this, code, reason);

        const permanentErrorCodes = [4004, 4005, 4006, 4009, 4015, 4016];
        if (permanentErrorCodes.includes(code)) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, new Error(`Permanent error on close: ${code} - ${reason}. Disabling reconnect for this node. Check credentials/config.`));
            return; // Do not attempt reconnect
        }

         // Attempt reconnect if enabled, not explicitly disconnected by user, and not already reconnecting
         if (this.options.reconnect && this.manager.explicitDisconnect !== this && !this.reconnectTimer) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] WebSocket closed (${code}: ${reason}). Attempting reconnect.`);
             this._attemptReconnect();
         } else if (this.manager.explicitDisconnect === this) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] WebSocket closed normally after explicit disconnect request.`);
             this.manager.explicitDisconnect = null;
        }
    }

    _handleError(error) {
        const msg = error.message || 'Unknown WebSocket Error';
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, error, `Error: ${msg}`);
        // Trigger reconnect explicitly on connection refusal/timeout errors
        if ((error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') && !this.connected && !this.reconnectTimer) {
            this._attemptReconnect();
        }
        // Let the 'close' event handle other WebSocket errors that lead to closure.
    }

     _attemptReconnect() {
         if (this.reconnectTimer) return; // Already scheduled

         // --- Added check: Don't attempt reconnect if userId is missing ---
        if (!this.manager.userId) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Skipping reconnect attempt: Manager userId not set.`);
             // Schedule a later check? For now, rely on manager init or explicit connect.
             return;
         }
         // --- End added check ---

        if (this.options.reconnect && this.reconnectAttempt >= this.options.reconnect.maxTries) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this, new Error(`Max reconnect attempts reached (${this.options.reconnect.maxTries}) for node ${this.identifier}. Giving up.`));
            // Don't disconnect here, it might already be closed. Consider node removal?
             this.manager._handleNodeDisconnection(this, true); // Mark as failed permanently for player migration
            return;
        }

        const delay = Math.min(
            this.options.reconnect.initialDelay * Math.pow(2, this.reconnectAttempt),
            this.options.reconnect.maxDelay
        );

        this.reconnectAttempt++;
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Scheduling reconnect attempt ${this.reconnectAttempt}/${this.options.reconnect.maxTries} in ${delay}ms.`);

        this.reconnectTimer = setTimeout(() => {
             this.reconnectTimer = null; // Clear timer before attempting connect
             // Keep existing sessionId if resumeKey is enabled, connect will handle it
             this._connect();
        }, delay);
    }

    updatePlayer(guildId, data = {}, noReplace = false) {
         if (!this.sessionId) return Promise.reject(new Error('Node has no active session ID.'));
        return this.rest.updatePlayer(guildId, { ...data, noReplace });
     }

    destroyPlayer(guildId) {
         if (!this.sessionId) return Promise.resolve(); // Can't destroy if no session
         return this.rest.destroyPlayer(guildId);
     }

    // This method is DEPRECATED for Lavalink V4 WS - payloads are typically sent via REST patches.
    // Keeping it stubbed out in case of future needs, but log a warning.
    send(payload) {
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] WARNING: Direct WebSocket send() called. Lavalink V4 prefers REST updates. Payload: ${JSON.stringify(payload)}`);
         // If implementation is needed later:
        /*
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
        */
         return Promise.resolve(); // V4 generally doesn't use WS send from client
    }


    configureResuming(key = this.resumeKey, timeout = this.resumeTimeout) {
        if (!this.sessionId) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Cannot configure resuming: no session ID established.`);
             return Promise.reject(new Error('Cannot configure resuming without a Session ID.'));
        }
         if (key) this.resumeKey = key;
         if (timeout) this.resumeTimeout = timeout;
         this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Configuring session resumption via REST: Key=${this.resumeKey}, Timeout=${this.resumeTimeout}s`);
        // Update Lavalink server with the desired timeout. Resuming itself is handled by headers/ready op.
        return this.rest.updateSession(undefined, this.resumeTimeout);
    }


    disconnect(code = 1000, reason = "Client initiated disconnect") {
         clearTimeout(this.reconnectTimer);
         this.reconnectTimer = null;
         // connected is already false if close event triggered this, set explicitly if direct call
         this.connected = false;
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Closing WebSocket explicitly (${code}: ${reason})`);
                this.manager.explicitDisconnect = this; // Mark that *we* initiated this close
                 this.ws.close(code, reason);
             } else if (this.ws.readyState === WebSocket.CONNECTING) {
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Terminating connecting WebSocket explicitly.`);
                this.ws.terminate(); // Force close if stuck connecting
             }
         }
         this.ws = null; // Nullify immediately
         // Clear session details immediately upon explicit disconnect request unless resuming is desired
        if (!this.resumeKey) {
             this.sessionId = null;
             this.rest.setSessionId(null);
        }
    }

    destroy() {
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Node ${this.identifier}] Destroying node instance.`);
        this.disconnect(1000, "Node destroyed");
        this.options.reconnect = null; // Disable reconnecting for destroyed node
        this.players.clear();
        this.removeAllListeners();
    }

    // Methods to link players to this node
     _addPlayer(player) {
         this.players.set(player.guildId, player);
     }
     _removePlayer(player) {
        this.players.delete(player.guildId);
     }
}

module.exports = Node;

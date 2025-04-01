const EventEmitter = require('events');
const Queue = require('./Queue');
const Constants = require('./Constants');

class Player extends EventEmitter {
    constructor(manager, node, guildId, options = {}) {
        super();
        this.manager = manager;
        this.node = node;
        this.guildId = guildId;
         this.options = { ...Constants.DEFAULT_PLAYER_OPTIONS, ...options };
        this.queue = new Queue();
        this.state = Constants.PLAYER_STATE.INSTANTIATED;

        // Voice connection state
        this.connected = false;
        this.voiceChannelId = null;
        this.voiceSessionId = null; // Discord Voice session_id
        this.voiceToken = null;     // Discord Voice token
        this.voiceEndpoint = null; // Discord Voice endpoint (without wss:// and ?v=4)

        // Playback state from Lavalink (mirrored)
        this.playing = false;
        this.paused = false;
        this.timestamp = null;
        this.position = 0; // Track position in ms
         this._lastPositionUpdate = 0; // When the position was last updated via event
         this.volume = this.options.initialVolume; // Set initial volume here
        this.loop = Constants.LOOP_MODE.NONE; // Set initial loop mode here

         this.moving = false; // Flag to indicate player is being moved between nodes
         this.ping = null; // Latency to Discord voice server, reported by Lavalink

         this.node._addPlayer(this); // Register player with its node
         this.on(Constants.CLIENT_EVENT_TYPES.PLAYER_STATE_UPDATE, (newState) => this._calculatePosition(newState));
     }

     get current() {
         return this.queue.current;
     }

     get isPlaying() {
         return this.connected && this.playing;
     }

     get isPaused() {
        return this.paused;
     }

     get currentPosition() {
        if (!this.isPlaying || this.paused || !this.timestamp) return this._lastPositionUpdate;
        const elapsed = Date.now() - this.timestamp;
        return Math.min(this._lastPositionUpdate + elapsed, this.current?.info.length ?? Infinity);
    }


     /**
      * Connects to a voice channel.
      * @param {string} channelId The ID of the voice channel to connect to.
      */
     connect(channelId) {
        if (!channelId) throw new Error("Channel ID is required to connect.");
         this.state = 'CONNECTING';
         this.voiceChannelId = channelId;
         this.manager._sendGatewayPayload(this.guildId, {
             op: 4,
             d: {
                guild_id: this.guildId,
                 channel_id: channelId,
                 self_mute: this.options.selfMute,
                 self_deaf: this.options.selfDeaf
             }
         });
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Requesting connection to channel ${channelId}`);
         this.connected = true; // Assume connection initiated, wait for voice updates
     }

     /**
      * Disconnects from the current voice channel.
      * @param {boolean} [destroyPlayer=true] Whether to destroy the player on Lavalink after disconnecting.
      */
     disconnect(destroyPlayer = true) {
        if (!this.connected) return;
         this.state = 'DISCONNECTING';
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Disconnecting from channel ${this.voiceChannelId}`);
         // Clear voice state first
         this.connected = false;
         this.voiceChannelId = null;
        this.voiceSessionId = null;
         this.voiceToken = null;
         this.voiceEndpoint = null;
         this.timestamp = null;
         this.position = 0;
         this._lastPositionUpdate = 0;

         // Send update to Discord Gateway
         this.manager._sendGatewayPayload(this.guildId, {
             op: 4,
            d: {
                 guild_id: this.guildId,
                channel_id: null,
                 self_mute: false,
                 self_deaf: false
             }
         });

        // Tell Lavalink to disconnect/destroy (if applicable) AFTER clearing local state
         if (destroyPlayer) {
            this.destroy();
        } else {
             this.stop(true); // Stop playback without destroying the player entity
         }
    }


     /**
      * Plays a track or starts the queue.
      * @param {object|string} [track] The Lavalink track object or encoded string to play. If omitted, starts the queue.
      * @param {object} [options] Play options.
      * @param {number} [options.startTime] Start playback at this position (milliseconds).
      * @param {number} [options.endTime] Stop playback at this position (milliseconds).
      * @param {boolean} [options.noReplace=false] If true, doesn't replace the current track if one is playing.
      * @param {boolean} [options.pause=false] If true, starts the track paused.
      * @returns {Promise<void>}
      */
     async play(track, options = {}) {
        const { startTime, endTime, noReplace = false, pause = false } = options;

         let trackToPlay = track;
        if (trackToPlay && typeof trackToPlay === 'object') {
             this.queue.current = trackToPlay; // Set explicit track as current
         } else if (!trackToPlay) {
             trackToPlay = this.queue.poll(); // Get next from queue
        }

         if (!trackToPlay) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
             // Don't stop here, Lavalink might need explicit stop if already playing something residual
             await this.stop(false); // Stop playback but keep player alive
             this.state = Constants.PLAYER_STATE.STOPPED;
            return;
         }


        const payload = {
            encodedTrack: typeof trackToPlay === 'string' ? trackToPlay : trackToPlay.encoded,
            volume: this.volume,
            position: startTime,
            endTime: endTime,
            paused: pause,
        };

         // Clear undefined properties Lavalink doesn't like
         Object.keys(payload).forEach(key => payload[key] === undefined && delete payload[key]);

         try {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Sending play request for track ${payload.encodedTrack?.substring(0,20)}... on Node ${this.node.identifier}`);
            await this.node.updatePlayer(this.guildId, payload, noReplace);
            this.playing = true;
             this.paused = pause;
             this.state = pause ? Constants.PLAYER_STATE.PAUSED : Constants.PLAYER_STATE.PLAYING;
             // Don't set timestamp here, wait for playerUpdate event
         } catch (error) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_EXCEPTION, this, this.queue.current ?? trackToPlay, error); // Use current or provided track
             // Attempt to play next if the error was related to this specific track
            await this._handleTrackEnd({ reason: 'loadFailed' }); // Simulate track end due to load failure
         }
    }

     /**
      * Stops the current playback and optionally clears the queue.
      * @param {boolean} [clearQueue=true] Whether to clear the queue after stopping.
      * @returns {Promise<void>}
      */
     async stop(clearQueue = true) {
        if(this.state === Constants.PLAYER_STATE.STOPPED) return;
         try {
             await this.node.updatePlayer(this.guildId, { encodedTrack: null }); // Send null track to stop
             this.playing = false;
             this.paused = false;
             this.timestamp = null;
             this.position = 0;
             this._lastPositionUpdate = 0;
             this.queue.current = null;
             this.state = Constants.PLAYER_STATE.STOPPED;
             if (clearQueue) {
                this.queue.clear();
             }
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Playback stopped.`);
         } catch (error) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, error, `Failed to stop player ${this.guildId}`);
            // Even if the API call fails, force the state locally
            this.playing = false;
            this.paused = false;
            this.state = Constants.PLAYER_STATE.STOPPED;
             if (clearQueue) this.queue.clear();
         }
    }

    /**
     * Skips the current track and plays the next one in the queue.
     * @returns {Promise<void>}
     */
     async skip() {
         if (!this.queue.current) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Skip called but nothing is playing.`);
            return;
        }
        // Directly call play without a track to trigger queue polling
         await this.play();
     }

     /**
      * Pauses or resumes the current playback.
      * @param {boolean} [pause=true] Set to true to pause, false to resume.
      * @returns {Promise<void>}
      */
     async pause(pause = true) {
         if (pause === this.paused) return; // Already in desired state

        if (!this.playing && pause) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Cannot pause, not currently playing.`);
            return;
        }

        if (this.playing && !this.paused && !pause){
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Already playing and not paused.`);
             return;
         }

        try {
             await this.node.updatePlayer(this.guildId, { paused: pause });
             this.paused = pause;
             // Update timestamp when pausing/resuming to ensure correct position calculation
             this.timestamp = Date.now();
             this._lastPositionUpdate = this.position; // Update base position on state change
             this.state = pause ? Constants.PLAYER_STATE.PAUSED : Constants.PLAYER_STATE.PLAYING;
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Playback ${pause ? 'paused' : 'resumed'}.`);
        } catch (error) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, error, `Failed to ${pause ? 'pause' : 'resume'} player ${this.guildId}`);
        }
    }

    /**
     * Resumes the current playback. Shortcut for `pause(false)`.
     * @returns {Promise<void>}
     */
    resume() {
        return this.pause(false);
    }

     /**
      * Seeks to a specific position in the current track.
      * @param {number} position Position in milliseconds.
      * @returns {Promise<void>}
      */
     async seek(position) {
        if (!this.playing || !this.queue.current || !this.queue.current.info.isSeekable) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Cannot seek: not playing, no current track, or track not seekable.`);
            return;
         }
         const targetPosition = Math.max(0, Math.min(position, this.queue.current.info.length)); // Clamp position
         try {
            await this.node.updatePlayer(this.guildId, { position: targetPosition });
            // Lavalink might send a playerUpdate, but update locally for immediate feedback if needed
            this.position = targetPosition;
             this._lastPositionUpdate = targetPosition;
            this.timestamp = Date.now();
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Seeked to ${targetPosition}ms.`);
        } catch (error) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, error, `Failed to seek player ${this.guildId} to ${targetPosition}`);
        }
     }

     /**
      * Sets the playback volume.
      * @param {number} volume Volume level (0-1000). Lavalink default is 100.
      * @returns {Promise<void>}
      */
     async setVolume(volume) {
        const targetVolume = Math.max(0, Math.min(volume, 1000)); // Clamp volume
         if (targetVolume === this.volume) return;

         try {
             await this.node.updatePlayer(this.guildId, { volume: targetVolume });
             this.volume = targetVolume; // Update local state optimistically
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Volume set to ${targetVolume}.`);
        } catch (error) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, error, `Failed to set volume for player ${this.guildId} to ${targetVolume}`);
        }
     }

    /**
     * Sets the loop mode for the queue.
     * @param {Constants.LOOP_MODE} mode Loop mode (NONE, TRACK, QUEUE).
     */
    setLoop(mode) {
         if (mode === undefined || mode < Constants.LOOP_MODE.NONE || mode > Constants.LOOP_MODE.QUEUE) {
             throw new Error(`Invalid loop mode: ${mode}. Use Constants.LOOP_MODE.`);
         }
        this.queue.setLoop(mode);
        this.loop = mode; // Sync player's loop state
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Loop mode set to ${Object.keys(Constants.LOOP_MODE).find(k => Constants.LOOP_MODE[k] === mode)}.`);
     }


    /**
     * Moves the player to a different Lavalink node.
     * @param {Node} targetNode The node to move to.
     * @returns {Promise<void>}
     */
    async moveToNode(targetNode) {
        if (!targetNode || targetNode === this.node || !targetNode.connected) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Cannot move: Invalid target node or target node not connected.`);
            throw new Error('Invalid or disconnected target node for move.');
        }
        if (this.moving) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Move already in progress.`);
            throw new Error('Player move already in progress.');
         }

        this.moving = true;
        const oldNode = this.node;
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Moving from Node ${oldNode.identifier} to Node ${targetNode.identifier}...`);


         // Store current state
        const currentTrack = this.queue.current;
         const stateToRestore = {
            encodedTrack: currentTrack?.encoded,
             position: this.currentPosition, // Get calculated current position
            volume: this.volume,
             pause: this.paused,
        };

        try {
             // 1. Destroy player on the old node WITHOUT disconnecting voice
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Destroying player state on old node ${oldNode.identifier}.`);
            await oldNode.destroyPlayer(this.guildId);

            // 2. Update internal node reference
             this.node._removePlayer(this);
            this.node = targetNode;
             this.node._addPlayer(this);

            // 3. Re-send voice state to the NEW node
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Sending voice state to new node ${targetNode.identifier}.`);
             if (this.voiceSessionId && this.voiceToken && this.voiceEndpoint) {
                await this._sendVoiceUpdate();
            } else {
                 // If voice state isn't fully available (maybe due to reconnect), might need re-connecting logic
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Voice state incomplete during move. Player might need to reconnect manually if issues occur.`);
                 throw new Error("Incomplete voice state during player move.");
             }

             // 4. Restore playback state on the new node
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Restoring player state on new node ${targetNode.identifier}.`);
             if (stateToRestore.encodedTrack) {
                 await this.node.updatePlayer(this.guildId, stateToRestore, false); // No replace needed, player is new on this node
                 this.playing = true; // Restore playing state flags
                this.paused = stateToRestore.pause;
                this.state = this.paused ? Constants.PLAYER_STATE.PAUSED : Constants.PLAYER_STATE.PLAYING;
                 // Wait for playerUpdate from new node to get accurate timestamp
             } else {
                this.playing = false;
                this.paused = false;
                 this.state = Constants.PLAYER_STATE.STOPPED;
             }

            this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_MOVE, this, oldNode, targetNode);
        } catch (error) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, targetNode, error, `Failed to move player ${this.guildId} to node ${targetNode.identifier}`);
            // Attempt to rollback or flag error
            // Rollback might be complex, consider simply destroying the player state
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Move failed. Attempting to clean up.`);
            try {
                 await this.destroy(); // Clean up state fully on failure
             } catch (destroyError) {
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Error during post-move-failure cleanup: ${destroyError.message}`);
             }
            throw error; // Re-throw original error
         } finally {
             this.moving = false;
        }
    }

     /**
      * Destroys the player instance and connection on Lavalink.
      * @returns {Promise<void>}
      */
     async destroy() {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) return;
        const wasConnected = this.connected;
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Destroying player...`);

         // Ensure disconnection happens before destroying Lavalink state
        if (wasConnected) {
             this.disconnect(false); // Disconnect voice but don't call destroyPlayer yet
         }
        this.state = Constants.PLAYER_STATE.DESTROYED;

        // Stop playback locally immediately
        this.playing = false;
        this.paused = false;
        this.queue.clear();


        try {
             // Now destroy the player on the Lavalink node
            await this.node.destroyPlayer(this.guildId);
        } catch (error) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, error, `Failed to destroy player ${this.guildId} on node ${this.node.identifier}. State might be inconsistent.`);
        } finally {
             // Cleanup references regardless of API success
             this.node._removePlayer(this);
            this.manager._destroyPlayer(this.guildId); // Notify manager last
             this.removeAllListeners(); // Clean up player event listeners
         }
    }

    // Internal methods for handling events and state updates

     _updateState(state) {
         this.timestamp = state.time ?? this.timestamp; // Keep old timestamp if null
         this.position = state.position ?? 0;
         this._lastPositionUpdate = this.position; // Always update base position from Lavalink
         this.connected = state.connected; // Update based on Lavalink's view of Discord connection
         this.ping = state.ping ?? this.ping;

        this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_STATE_UPDATE, this, state);
        this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_STATE_UPDATE, state); // Emit on player itself too
    }

    _calculatePosition(state = null){
        // This is primarily handled by the currentPosition getter now.
         // This function could be used for more complex scenarios if needed later.
        if(state?.position !== undefined) this.position = state.position;
        if(state?.time !== undefined) this.timestamp = state.time;
     }

     async _handleVoiceStateUpdate(data) {
        // Handle situations where channelId becomes null (manual disconnect, kicked)
        if (data.channel_id === null && this.voiceChannelId && this.guildId === data.guild_id && data.user_id === this.manager.userId) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Voice state indicates disconnection from channel ${this.voiceChannelId}.`);
            this.connected = false;
             this.state = 'DISCONNECTED'; // More specific than just STOPPED
             // Don't destroy automatically, let user decide or inactivity handle it
             return;
        }

        // Only process updates for the bot user in the player's guild
         if (data.guild_id !== this.guildId || data.user_id !== this.manager.userId) return;


         // If connecting and receive the update for the target channel
        if (this.state === 'CONNECTING' && data.channel_id === this.voiceChannelId) {
            this.voiceSessionId = data.session_id;
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Received Voice State Update (Session: ${this.voiceSessionId}). Waiting for Server Update.`);
            this.state = 'CONNECTING_SERVER'; // Advance state
             // Wait for voice server update
        } else if (data.channel_id && data.channel_id !== this.voiceChannelId) {
             // Moved to a different channel - update state
             const oldChannel = this.voiceChannelId;
             this.voiceChannelId = data.channel_id;
             this.voiceSessionId = data.session_id;
             this.state = 'MOVING_CHANNEL';
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Bot moved from channel ${oldChannel} to ${this.voiceChannelId}. Waiting for Server Update.`);
             // Wait for voice server update
         } else if (!data.channel_id && this.voiceChannelId){
             // User manually disconnected bot / kicked etc.
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Detected bot disconnected from channel ${this.voiceChannelId}. Cleaning up player state.`);
             this.disconnect(true); // Trigger full disconnect and destroy
        }

        // If we already have Server Info, attempt sending update
         if (this.voiceSessionId && this.voiceToken && this.voiceEndpoint) {
            await this._sendVoiceUpdate();
         }
    }

    async _handleVoiceServerUpdate(data) {
        // Check if this update is relevant (correct guild) and if we were waiting for it
        if (data.guild_id !== this.guildId || (this.state !== 'CONNECTING_SERVER' && this.state !== 'MOVING_CHANNEL')) {
            return;
        }

        this.voiceToken = data.token;
        // Strip prefix/suffix from endpoint for Lavalink
        this.voiceEndpoint = data.endpoint?.replace(':80', '').replace(':443', '').replace('wss://', ''); // Handle common ports/protocol

         if (!this.voiceEndpoint){
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Received Voice Server Update but endpoint is null. Cannot proceed.`);
             // Handle error case - perhaps disconnect or retry?
            await this.disconnect(true);
             throw new Error(`Voice server endpoint was null for guild ${this.guildId}.`);
        }

        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Received Voice Server Update (Endpoint: ${this.voiceEndpoint}). Sending update to Lavalink.`);
        this.connected = true; // Mark as fully connected before sending to Lavalink
         this.state = this.playing ? (this.paused ? Constants.PLAYER_STATE.PAUSED : Constants.PLAYER_STATE.PLAYING) : Constants.PLAYER_STATE.STOPPED; // Set proper state
         await this._sendVoiceUpdate();

     }

     _sendVoiceUpdate() {
        if (!this.voiceSessionId || !this.voiceToken || !this.voiceEndpoint) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Cannot send voice update, missing state information.`);
             return Promise.reject(new Error("Missing voice state information"));
        }
         // Use node's updatePlayer method, providing the voice object
        return this.node.updatePlayer(this.guildId, {
             voice: {
                token: this.voiceToken,
                endpoint: this.voiceEndpoint,
                 sessionId: this.voiceSessionId
            }
        }).catch(err => {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, err, `Failed to send voice update for player ${this.guildId}`);
            // If sending voice state fails, it likely means the Discord<->Lavalink connection broke
             // Consider disconnecting the player
             this.disconnect(true);
         });
     }


    _handleEvent(payload) {
         const previousTrack = this.queue.current; // Get current track before potentially changing it

        switch (payload.type) {
            case Constants.LAVA_EVENT_TYPES.TRACK_START:
                this.playing = true;
                 this.paused = false;
                 this.state = Constants.PLAYER_STATE.PLAYING;
                this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_START, this, this.queue.current); // Emit with the confirmed current track
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_START, this, this.queue.current);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Event: TrackStart (${this.queue.current?.info?.title})`);
                break;

            case Constants.LAVA_EVENT_TYPES.TRACK_END:
                 this.playing = false;
                 // Note: `position` will be set by playerUpdate if available, don't reset here necessarily
                 // Reset timestamp if track actually ended (or stopped)
                if (payload.reason !== 'replaced') {
                    this.timestamp = null;
                    this.position = 0;
                     this._lastPositionUpdate = 0;
                 }
                this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_END, this, previousTrack, payload); // Emit with the track that just ended
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_END, this, previousTrack, payload);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Event: TrackEnd (${previousTrack?.info?.title}, Reason: ${payload.reason})`);
                 this._handleTrackEnd(payload); // Process loop/queue logic
                break;

            case Constants.LAVA_EVENT_TYPES.TRACK_EXCEPTION:
                 this.playing = false;
                 this.timestamp = null;
                 this.position = 0;
                 this._lastPositionUpdate = 0;
                 this.state = Constants.PLAYER_STATE.STOPPED;
                this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_EXCEPTION, this, previousTrack, payload);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_EXCEPTION, this, previousTrack, payload.exception);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Event: TrackException (${previousTrack?.info?.title}, Reason: ${payload.exception.message})`);
                // Optionally play next track on certain exceptions? Maybe depends on severity
                 // this._handleTrackEnd(payload); // Treat exception as track end for queue processing
                 if(payload.exception?.severity?.toLowerCase() !== "fault"){ // Continue queue unless it's a major fault
                     this._handleTrackEnd(payload);
                 } else {
                     this.queue.clear(); // Clear queue on Fault level exceptions
                    this.queue.current = null; // Clear current too
                     // Possibly destroy player? Or let user handle it.
                     this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, new Error(`Track Fault: ${payload.exception.message}`), `Player ${this.guildId}`);
                 }
                break;

            case Constants.LAVA_EVENT_TYPES.TRACK_STUCK:
                 this.playing = false; // Might still be 'playing' in Lavalink, but stalled
                 this.state = Constants.PLAYER_STATE.STOPPED; // Treat as stopped from client perspective
                 this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_STUCK, this, previousTrack, payload);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_STUCK, this, previousTrack, payload.thresholdMs);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Event: TrackStuck (${previousTrack?.info?.title}, Threshold: ${payload.thresholdMs}ms)`);
                this._handleTrackEnd(payload); // Treat stuck track as end for queue processing
                 break;

            case Constants.LAVA_EVENT_TYPES.WEBSOCKET_CLOSED:
                // This indicates the connection between Lavalink and Discord's voice ws closed
                 this.connected = false; // Lavalink reports disconnected
                this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_WEBSOCKET_CLOSED, this, payload);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_WEBSOCKET_CLOSED, this, payload);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, new Error(`Discord WebSocket closed for player ${this.guildId}. Code: ${payload.code}, Reason: ${payload.reason}, By Remote: ${payload.byRemote}`));
                // This often requires manual intervention (reconnecting the player/bot)
                // Consider disconnecting fully if error code suggests unrecoverable issue
                 if(![4006, 4014, 4015, 1000].includes(payload.code) && this.connected) {
                     // If it wasn't a known "bot interaction" disconnect or normal close, attempt full player reconnect.
                     this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Attempting reconnect after Discord WS close (${payload.code})`);
                    this.state = "RECONNECTING";
                     this.connect(this.voiceChannelId); // Re-initiate connection process
                 } else if (this.connected){ // Normal close codes, or when already marked as disconnected
                     this.disconnect(true); // Cleanly disconnect and destroy player
                 }
                 break;
            default:
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Received unknown event type: ${payload.type}`);
        }
    }

    _handleTrackEnd(payload) {
        // Handle track looping first
         if (this.loop === Constants.LOOP_MODE.TRACK && payload.reason !== 'replaced' && payload.reason !== 'stopped') {
             const trackToReplay = this.queue.current ?? this.queue.history[0]; // Get current or last played for looping
             if (trackToReplay) {
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Replaying track due to TRACK loop.`);
                this.play(trackToReplay); // Replay the current track
                return;
            }
         }

        // Don't advance queue if track was manually stopped or replaced
         if (payload.reason === 'stopped' || payload.reason === 'replaced') {
             if (payload.reason === 'stopped') this.state = Constants.PLAYER_STATE.STOPPED;
             // If stopped, current should already be null or is cleared by stop()
             if (!this.queue.current && this.state !== Constants.PLAYER_STATE.DESTROYED && this.queue.isEmpty) {
                 this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
            }
             return;
        }

        // Check for queue loop
         if (this.loop === Constants.LOOP_MODE.QUEUE) {
            const nextTrack = this.queue.poll(); // This will re-add the current track to the end via the Queue's logic
            if (nextTrack) {
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Playing next track due to QUEUE loop.`);
                this.play(nextTrack);
            } else {
                // Queue is empty even with looping (should only happen if queue was initially empty)
                 this.queue.current = null; // Clear current explicitly
                 this.playing = false;
                 this.paused = false;
                 this.state = Constants.PLAYER_STATE.STOPPED;
                 this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Queue loop enabled but queue became empty.`);
                 this.stop(false); // Ensure Lavalink player is stopped if queue empty.
             }
            return;
        }


         // Default: No loop or TRACK loop just finished, play next
        const nextTrack = this.queue.poll();
         if (nextTrack) {
            this.play(nextTrack);
         } else {
             // Queue is now empty
             this.queue.current = null; // Ensure current track is cleared
            this.playing = false;
             this.paused = false;
            this.state = Constants.PLAYER_STATE.STOPPED;
             this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Queue finished.`);
             // Optionally auto-disconnect or start autoplay feature here
             // For now, just stop
            this.stop(false); // Ensure Lavalink player is stopped if queue empty.
         }
    }
}

module.exports = Player;

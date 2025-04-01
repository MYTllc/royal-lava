const { URLSearchParams } = require('url');
const Constants = require('./Constants');

class Rest {
    constructor(node) {
        this.node = node;
        this.manager = node.manager;
        this.url = `http${node.options.secure ? 's' : ''}://${node.options.host}:${node.options.port}`;
        this.password = node.options.password;
        this.sessionId = null; // Will be set by Node upon receiving 'ready'
    }

    setSessionId(id) {
        this.sessionId = id;
    }

    async makeRequest(endpoint, options = {}) {
        const { method = 'GET', body, params, attempt = 1 } = options;

        const headers = {
            'Authorization': this.password,
            'User-Agent': `advanced-lavalink-v4/${this.manager.userId}`
        };
        if (body) headers['Content-Type'] = 'application/json';

        let url = `${this.url}${endpoint}`;
        if (params) {
            url += `?${new URLSearchParams(params)}`;
        }

        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[REST] --> ${method} ${url} (Session: ${this.sessionId ?? 'None'})`);

        let response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(15000) // 15 second timeout
            });
        } catch (e) {
            if (e.name === 'TimeoutError' || e.name === 'AbortError' || e.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[REST] <-- ${method} ${url} Failed (Timeout, Attempt: ${attempt})`);
                if (attempt < this.node.options.retryAmount) {
                     await new Promise(r => setTimeout(r, 500 * attempt));
                     return this.makeRequest(endpoint, { ...options, attempt: attempt + 1 });
                 } else {
                    throw new Error(`Request timed out after ${attempt} attempts: ${method} ${endpoint}`);
                 }
             } else if (e.cause?.code === 'ECONNREFUSED') {
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, new Error(`Connection refused for REST request: ${method} ${url}`), attempt);
             }
             throw e; // Rethrow other errors
        }

        let responseBody;
        if (response.headers.get('content-type')?.includes('application/json')) {
             responseBody = await response.json().catch(() => null);
         } else {
             responseBody = await response.text().catch(() => null);
         }

        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[REST] <-- ${method} ${url} ${response.status} ${response.statusText}`);


        if (!response.ok) {
            let errorMsg = `REST Error: ${response.status} ${response.statusText} on ${method} ${endpoint}`;
             if (responseBody && typeof responseBody === 'object') {
                errorMsg += ` | Message: ${responseBody.message} | Path: ${responseBody.path}`;
            } else if (responseBody){
                 errorMsg += ` | Body: ${responseBody.substring(0, 100)}`;
             }

             if (response.status === 404 && endpoint.startsWith('/v4/sessions')) {
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[REST] Session likely invalid (${this.sessionId}) or Player not found. Triggering potential reconnect.`);
                 // A 404 on a session or player endpoint might indicate the session died.
                 // The node disconnect handler should trigger a reconnect, this is just for logging.
                 if(this.node.ws?.readyState === this.node.WebSocket.OPEN){
                    // If WS is still open, maybe the player just doesn't exist? Let the calling function handle this.
                 } else if (this.node.connected) {
                    this.node.disconnect(4004, 'REST Session Invalid / Player Not Found');
                 }

             }

             const error = new Error(errorMsg);
             error.status = response.status;
             error.body = responseBody;
            throw error;
        }

         return responseBody;
    }

     // V4 Endpoints
     async getVersion() {
         return this.makeRequest('/version');
     }

     async getInfo() {
         return this.makeRequest('/v4/info');
     }

     async getStats() {
         return this.makeRequest('/v4/stats');
     }

    async loadTracks(identifier) {
        return this.makeRequest('/v4/loadtracks', { params: { identifier } });
    }

    async decodeTrack(encodedTrack) {
        return this.makeRequest('/v4/decodetrack', { params: { encodedTrack } });
    }

     async decodeTracks(encodedTracks) {
         return this.makeRequest('/v4/decodetracks', { method: 'POST', body: encodedTracks });
     }

    // Session Endpoints
     async updateSession(resume, timeout) {
        if (!this.sessionId) throw new Error('Cannot update session without a Session ID.');
        const payload = {};
         if (typeof resume === 'boolean') payload.resuming = resume;
        if (typeof timeout === 'number') payload.timeout = timeout;
         if (Object.keys(payload).length === 0) return Promise.resolve(); // No changes needed
        return this.makeRequest(`/v4/sessions/${this.sessionId}`, { method: 'PATCH', body: payload });
    }

     // Player Endpoints
    async getPlayer(guildId) {
        if (!this.sessionId) throw new Error('Cannot get player without a Session ID.');
        return this.makeRequest(`/v4/sessions/${this.sessionId}/players/${guildId}`);
    }

    async updatePlayer(guildId, data) {
        if (!this.sessionId) throw new Error('Cannot update player without a Session ID.');
        const { noReplace = false, ...payload } = data; // Separate Lavalink options from our own
        return this.makeRequest(`/v4/sessions/${this.sessionId}/players/${guildId}`, {
            method: 'PATCH',
            params: { noReplace: String(noReplace) }, // Must be string for URLSearchParams
            body: payload
        });
    }

    async destroyPlayer(guildId) {
         if (!this.sessionId) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[REST] Cannot destroy player ${guildId}, no session ID.`);
             return Promise.resolve(); // Can't destroy if we don't have a session
         }
        return this.makeRequest(`/v4/sessions/${this.sessionId}/players/${guildId}`, { method: 'DELETE' });
    }
}

module.exports = Rest;

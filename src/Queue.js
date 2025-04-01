const Constants = require('./Constants');

class Queue {
    constructor() {
        this.tracks = [];
        this.previousTracks = [];
        this._current = null;
        this.loop = Constants.LOOP_MODE.NONE;
    }

    get current() {
        return this._current;
    }

    set current(track) {
        if (this._current) {
            this.previousTracks.unshift(this._current);
            if (this.previousTracks.length > 20) { // Limit history size
                 this.previousTracks.pop();
            }
        }
        this._current = track;
    }

    get upcoming() {
        return this.tracks;
    }

    get history() {
         return this.previousTracks;
    }

    get size() {
        return this.tracks.length;
    }

    get totalSize() {
        return this.previousTracks.length + this.tracks.length + (this.current ? 1 : 0);
    }

     get duration() {
         const currentDuration = this.current?.info.length || 0;
         const upcomingDuration = this.tracks.reduce((acc, cur) => acc + (cur.info?.length || 0), 0);
         return currentDuration + upcomingDuration;
    }

     get isEmpty() {
         return this.tracks.length === 0 && !this.current;
    }

    add(track, position) {
        if (Array.isArray(track)) {
             if (typeof position === 'number' && position >= 0 && position <= this.tracks.length) {
                this.tracks.splice(position, 0, ...track);
             } else {
                 this.tracks.push(...track);
             }
        } else {
             if (typeof position === 'number' && position >= 0 && position <= this.tracks.length) {
                this.tracks.splice(position, 0, track);
             } else {
                this.tracks.push(track);
             }
        }
    }

    poll() {
        if (this.loop === Constants.LOOP_MODE.TRACK && this.current) {
            return this.current;
        }
         if (this.loop === Constants.LOOP_MODE.QUEUE) {
            if (this.current) this.tracks.push(this.current); // Re-add current to end
            const next = this.tracks.shift();
            this.current = next; // Will handle previous track adding in setter
            return next;
         }

         const next = this.tracks.shift();
         this.current = next; // Will handle previous track adding in setter
         return next;
    }

    remove(indexOrTrack) {
        let removedTrack = null;
        if (typeof indexOrTrack === 'number') {
             if (indexOrTrack >= 0 && indexOrTrack < this.tracks.length) {
                removedTrack = this.tracks.splice(indexOrTrack, 1)[0];
             }
        } else if (typeof indexOrTrack === 'object' && indexOrTrack?.encoded) {
            const index = this.tracks.findIndex(t => t.encoded === indexOrTrack.encoded);
            if (index !== -1) {
                removedTrack = this.tracks.splice(index, 1)[0];
            }
        }
         return removedTrack;
    }

    clear() {
        this.tracks = [];
        this.previousTracks = [];
        this._current = null;
    }

    shuffle() {
        for (let i = this.tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
        }
    }

    setLoop(mode) {
        if (mode >= Constants.LOOP_MODE.NONE && mode <= Constants.LOOP_MODE.QUEUE) {
            this.loop = mode;
        } else {
            throw new Error(`Invalid loop mode: ${mode}. Use LoopMode constants.`);
        }
    }
}

module.exports = Queue;

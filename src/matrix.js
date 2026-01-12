import EventEmitter from 'node:events';

class MatrixServer extends EventEmitter{

    constructor(homeserver, roomID, token) {
        super()
        this.homeserver = homeserver;
        this.roomID = roomID;
        this.token = token;
        this.nextBatch = null;
        this.userId = null;
        this.loop();
    }

    async getUserId() {
        try {
            const res = await fetch(`${this.homeserver}/_matrix/client/v3/account/whoami`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) throw new Error(`Whoami failed: ${res.status}`);
            const data = await res.json();
            this.userId = data.user_id;
        } catch (err) {
            console.error('Failed to get user ID:', err.message);
            throw err;
        }
    }

    updateConfig(homeserver, roomID, token) {
        
        if (this.roomID !== roomID) {
            // If we switch room, we need to pull all messages.
            this.nextBatch = null;
            this.roomID = roomID;
        }
        
        // Reset userId so it gets re-fetched with new token/server if needed
        if (this.homeserver !== homeserver || this,token !== token) {

            this.homeserver = homeserver;
            this.token = token;
            
            this.userId = null; 
        }

        console.log('MatrixServer config updated');
    }

    async loop () {
        try {
            if (!this.userId) {
                await this.getUserId();
            }

            let data;
            const isInitialSync = this.nextBatch === null;
            if (isInitialSync) {
                data = await this.getNextBatch();
            } else {
                data = await this.getNextBatch(30000, this.nextBatch || '');
            }
            
            this.nextBatch = data.next_batch;
            
            // Process events
            const rooms = data.rooms?.join || {};
            if (rooms[this.roomID]) {
                 const timeline = rooms[this.roomID].timeline?.events || [];
                 for (const event of timeline) {
                     if (isInitialSync && event.origin_server_ts < Date.now() - 15 * 60 * 1000) {
                         continue;
                     }

                     if (event.type === 'm.reaction') {
                         const relatesTo = event.content?.['m.relates_to'];
                         if (relatesTo && relatesTo.rel_type === 'm.annotation') {
                             const key = relatesTo.key; // The emoji
                             const targetEventId = relatesTo.event_id;
                             
                            this.emit("reaction", {key: key, targetEventId: targetEventId});
                         }
                     } else if (event.type === 'm.room.message') {
                        const relations = event.unsigned?.['m.relations']?.['m.annotation'];
                        if (relations?.chunk) {
                            const myReaction = relations.chunk.find(r => r.sender === this.userId && r.key === '☑️');
                            if (myReaction) {
                                continue;
                            }
                        }

                        if (event.sender !== this.userId) {
                            this.emit('userMessage', event);
                        }
                     }
                 }
            }

        } catch (error) {
            console.error('Sync error:', error.message);
            await new Promise(r => setTimeout(r, 5000)); // Backoff
        }
        setImmediate(() => this.loop());
    };

    async sendMatrixNotification (messageContent) {
        console.log(`Sending Matrix notification (length: ${messageContent.length})`);
        if (!this.token || !this.roomID) {
            console.error('Missing Matrix config, cannot send notification');
            return null;
        }
        const txnId = new Date().getTime() + '_' + Math.random().toString(36).substring(2, 9);
        const url = `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(this.roomID)}/send/m.room.message/${txnId}`;

        try {
            const response = await fetch(url, {
                method: 'PUT',
                body: JSON.stringify({
                    body: messageContent,
                    format: "org.matrix.custom.html",
                    formatted_body: messageContent.replace(/\n/g, '<br>')
                    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                    .replace(/## (.*?)(\n|<br>)/, '<h3>$1</h3>')
                    .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>'),
                    msgtype: "m.text"
                }),
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            console.log(`Matrix event sent: ${data.event_id}`);
            return data.event_id;
        } catch (error) {
            console.error('Failed to send Matrix notification:', error.message);
            return null;
        }
    }

    async getNextBatch(timeout = 0, since = null) {
        let url = `${this.homeserver}/_matrix/client/v3/sync?timeout=${timeout}`
        if (since !== null) {
            url += `&since=${since}`
        }
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });

        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();
        return data;
    }

    async sendReaction(matrixEventId, key = '☑️') {
         const reactionTxnId = new Date().getTime() + '_react_' + Math.random().toString(36).substring(2, 9);
            try {
                const reactRes = await fetch(`${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(this.roomID)}/send/m.reaction/${reactionTxnId}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        "m.relates_to": {
                            "rel_type": "m.annotation",
                            "event_id": matrixEventId,
                            "key": key
                        }
                    }),
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    }
                });
                if (!reactRes.ok) {
                    throw new Error(`HTTP error! status: ${reactRes.status}`);
                }
            } catch (reactErr) {
                console.error('Failed to send confirmation reaction:', reactErr.message);
            }
    }
    async listJoinedRooms() {

        console.log('Fetching joined rooms...');
        try {
            const res = await fetch(`${this.homeserver}/_matrix/client/v3/joined_rooms`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            const data = await res.json();

            const rooms = data.joined_rooms || [];
            console.log(`Joined to ${rooms.length} rooms:`);

            for (const roomId of rooms) {
                let name = '';
                try {
                    const nameRes = await fetch(`${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, {
                        headers: { 'Authorization': `Bearer ${this.token}` }
                    });
                    if (nameRes.ok) {
                        const nameData = await nameRes.json();
                        name = nameData.name;
                    }
                } catch (err) {
                    // Ignore errors fetching name (e.g. 404 if not set)
                }
                console.log(`- ${roomId}${name ? ` (${name})` : ''}`);
            }
        } catch (error) {
            console.error('Failed to fetch joined rooms:', error.message);
        }
    }
}

export { MatrixServer };
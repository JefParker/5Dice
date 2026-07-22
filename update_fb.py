import re

with open("Score/firebase-backend.js", "r") as f:
    content = f.read()

# Add query and limitToLast to imports
if "query" not in content:
    content = content.replace("serverTimestamp", "serverTimestamp, query, limitToLast")

new_init_events = """    initEvents: (room, onMessageCallback) => {
        if (!room) return;
        window.firebaseBackend.isConnected = true;
        
        if (window.firebaseBackend.currentUnsubscribe) {
            window.firebaseBackend.currentUnsubscribe();
            window.firebaseBackend.currentUnsubscribe = null;
        }

        const eventsRef = ref(db, `rooms/${room}/events`);
        
        // Fetch server time offset to handle clock skew accurately
        const offsetRef = ref(db, ".info/serverTimeOffset");
        get(offsetRef).then((snap) => {
            const offset = snap.val() || 0;
            const serverStartTime = Date.now() + offset;
            
            // Only listen to the last 20 events to save bandwidth and ignore deep history
            const q = query(eventsRef, limitToLast(20));
            const unsubscribe = onChildAdded(q, (snapshot) => {
                const val = snapshot.val();
                // Ignore events older than 10 seconds before we joined the room
                if (val && (!val.timestamp || val.timestamp > serverStartTime - 10000)) {
                    onMessageCallback(val.jsonData);
                }
            });
            window.firebaseBackend.currentUnsubscribe = unsubscribe;
        });
    },"""

pattern = re.compile(r"\s*initEvents: \(room, onMessageCallback\) => \{.*?\},\n", re.DOTALL)

if pattern.search(content):
    content = pattern.sub("\n" + new_init_events + "\n", content)
    with open("Score/firebase-backend.js", "w") as f:
        f.write(content)
    print("Success replacing initEvents")
else:
    print("initEvents not found")


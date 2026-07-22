import re

with open("Score/firebase-backend.js", "r") as f:
    content = f.read()

new_init_events = """    currentUnsubscribe: null,

    initEvents: (room, onMessageCallback) => {
        if (!room) return;
        window.firebaseBackend.isConnected = true;
        
        if (window.firebaseBackend.currentUnsubscribe) {
            window.firebaseBackend.currentUnsubscribe();
            window.firebaseBackend.currentUnsubscribe = null;
        }

        const eventsRef = ref(db, `rooms/${room}/events`);
        const startTime = Date.now();
        
        const unsubscribe = onChildAdded(eventsRef, (snapshot) => {
            const val = snapshot.val();
            if (val && val.timestamp > startTime - 10000) {
                onMessageCallback(val.jsonData);
            }
        });
        
        // Save the unsubscribe function so we can remove the listener later
        window.firebaseBackend.currentUnsubscribe = unsubscribe;
    },"""

pattern = re.compile(r"\s*initEvents: \(room, onMessageCallback\) => \{.*?\},\n", re.DOTALL)

if pattern.search(content):
    new_content = pattern.sub("\n" + new_init_events + "\n", content)
    with open("Score/firebase-backend.js", "w") as f:
        f.write(new_content)
    print("Success")
else:
    print("Pattern not found!")

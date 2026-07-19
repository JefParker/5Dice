import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, child } from "firebase/database";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

get(child(ref(db), `rooms/143/events`)).then((snapshot) => {
  if (snapshot.exists()) {
    console.log("Events found:");
    const events = snapshot.val();
    for (const key in events) {
        console.log(events[key].jsonData);
    }
  } else {
    console.log("No data available");
  }
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

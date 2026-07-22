import re

with open("Score/Score.js", "r") as f:
    content = f.read()

pattern = re.compile(r"/\* Start WebSocket Code \*/\s*let initWebSocket = \(\) => \{.*?\n\}\s*let stopWebSocket = \(\) => \{\}\s*let close_socket = \(\) => \{\}\s*let CheckConnection = \(\) => \{[^\}]*\}\s*let sendMessage = \(jsonData\) => \{.*?\n\}", re.DOTALL)

new_ws_code = """/* Start WebSocket Code */
let initWebSocket = () => {
    if (!window.firebaseBackend) {
        setTimeout(initWebSocket, 100);
        return;
    }

    if (!g_objGame.id) {
        g_objGame.id = Math.floor(Math.random() * 1000000000);
        setTimeout(() => {
            let objData = {
                Message: "PlayerEnteringGame",
                Type: "Score",
                GameID: parseInt(g_objUserData.GameID),
                ID: g_objGame.id,
                Name: g_objScore.Name ? g_objScore.Name : "Score"
            };
            sendMessage(JSON.stringify(objData));
        }, 1000);
    }

    window.firebaseBackend.initEvents(g_objUserData.GameID, (evtData) => {
        if (typeof evtData === "string") {
            let objData = JSON.parse(evtData);
            if ("Score" == objData.Type) {
                if ("BCast2Game" == objData.Message || ("Msg2ID" == objData.Message && objData.ToID == g_objGame.id)) {
                    if ("Notification" == objData.Event) {
                        showNotification(objData.Title, objData.Text, true);
                    }
                    else if ("Toast" == objData.Event) {
                        ColorToast(objData.Text, objData.Color);
                    }
                    else if ("UpdateScore" == objData.Event) {
                        if (document.getElementById("LeaderBoardEntries"))
                            document.getElementById("LeaderBoardEntries").innerHTML = LeaderList(objData.Player);
                        let objPlayer = JSON.parse(objData.Player);
                        if (objPlayer.PlayerID == g_objGame.ScoreSheetShowing) {
                            DisplayScore(objPlayer);
                        }
                    }
                    else if ("RequestScore" == objData.Event) {
                        SendScore2ID(objData.ID, JSON.stringify(g_objScore));
                    }
                    else if ('RequestLeaderBoard' == objData.Event) {
                        SendLeaderBoard2ID(objData.ID, JSON.stringify(g_objGame.LeaderList));
                    }
                    else if ('UpdateLeaderBoard' == objData.Event) {
                        let objLeaderBoard = JSON.parse(objData.LeaderBoard);
                        for (let x=0; x<objLeaderBoard.length; x++) {
                            let jsonPlayer = JSON.stringify(objLeaderBoard[x]);
                            if (document.getElementById("LeaderBoardEntries"))
                                document.getElementById("LeaderBoardEntries").innerHTML = LeaderList(jsonPlayer);
                        }
                    }
                }
            }
            if ("PlayerEnteringGame" == objData.Message || "PlayerExitingGame" == objData.Message) {
                if (objData.ID !== g_objGame.id) {
                    if ("PlayerEnteringGame" == objData.Message) {
                        let sColor = FindColorbyName(objData);
                        ColorToast(objData.Name + " has arrived", sColor);
                        BCastRequestScores();
                    } else if ("PlayerExitingGame" == objData.Message) {
                        let sColor = FindColorbyName(objData);
                        ColorToast(objData.Name + " has left", sColor);
                    }
                }
            }
        }
    });
}
let stopWebSocket = () => {}
let close_socket = () => {}
let CheckConnection = () => { if (!window.firebaseBackend || !window.firebaseBackend.isConnected) initWebSocket(); }
let sendMessage = (jsonData) => {
    if (!window.firebaseBackend) {
        setTimeout(() => sendMessage(jsonData), 500);
        return;
    }
    window.firebaseBackend.sendEvent(g_objUserData.GameID, jsonData);
}"""

if pattern.search(content):
    new_content = pattern.sub(new_ws_code, content)
    with open("Score/Score.js", "w") as f:
        f.write(new_content)
    print("Success")
else:
    print("Pattern not found!")


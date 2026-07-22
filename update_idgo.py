import re

with open("Score/Score.js", "r") as f:
    content = f.read()

# Update initWebSocket
pattern_init = re.compile(r"/\* Start WebSocket Code \*/\s*let initWebSocket = \(\) => \{.*?\n\}\s*let stopWebSocket", re.DOTALL)

new_ws_code = """/* Start WebSocket Code */
let initWebSocket = () => {
    if (!window.firebaseBackend) {
        setTimeout(initWebSocket, 100);
        return;
    }

    if (!g_objGame.id) {
        g_objGame.id = Math.floor(Math.random() * 1000000000);
    }

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
let stopWebSocket"""

if pattern_init.search(content):
    content = pattern_init.sub(new_ws_code, content)
    print("Init WS replaced successfully.")
else:
    print("Init WS pattern not found!")

# Update IDGo
pattern_idgo = re.compile(r"const IDGo = \(\) => \{\s*let nGameID = document\.getElementById\('GameID'\)\.value\.trim\(\);\s*if \(g_objUserData\.GameID != nGameID\) \{\s*CheckConnection\(\);\s*g_objUserData\.GameID = nGameID;\s*g_objGame\.LeaderList = \[\];\s*setTimeout\(function\(\) \{BCastRequestScores\(\);\}, 2000\);\s*\}")

new_idgo = """const IDGo = () => {
    let nGameID = document.getElementById('GameID').value.trim();
    if (g_objUserData.GameID != nGameID) {
        g_objUserData.GameID = nGameID;
        initWebSocket();
        g_objGame.LeaderList = [];
        setTimeout(function() {BCastRequestScores();}, 2000);
    }"""

if pattern_idgo.search(content):
    content = pattern_idgo.sub(new_idgo, content)
    print("IDGo replaced successfully.")
else:
    print("IDGo pattern not found!")


with open("Score/Score.js", "w") as f:
    f.write(content)


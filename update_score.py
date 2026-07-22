import sys

with open("Score/Score.js", "r") as f:
    lines = f.readlines()

new_ws_code = """/* Start WebSocket Code */
let initWebSocket = () => {
    if (!window.firebaseBackend) {
        setTimeout(initWebSocket, 100);
        return;
    }
    window.firebaseBackend.initEvents(g_objUserData.GameID, (evtData) => {
        if (typeof evtData === "string") {
            let objData = JSON.parse(evtData);
            if ("Score" == objData.Type) {
                if ("BCast2Game" == objData.Message || "Msg2ID" == objData.Message) {
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
                if ("PlayerEnteringGame" == objData.Message) {
                    let sColor = FindColorbyName(objData);
                    ColorToast(objData.Name + " has arrived", sColor);
                    BCastRequestScores();
                } else if ("PlayerExitingGame" == objData.Message) {
                    let sColor = FindColorbyName(objData);
                    ColorToast(objData.Name + " has left", sColor);
                }
                if (objData.PlayersIDHere) {
                    let nPlayers = countCurrentUsers(objData.PlayersIDHere);
                    let sPlayerLabel = (nPlayers > 1) ? "users" : "user";
                    if (document.getElementById('WhosHere')) document.getElementById('WhosHere').innerHTML = g_objGame.WhosHere = "<span onclick='CheckConnection()'>" + nPlayers + " " + sPlayerLabel + "</span>";
                    if (document.getElementById('NamesHere')) document.getElementById('NamesHere').innerHTML = objData.PlayersNameList ? objData.PlayersNameList : "";
                }
            } else {
                if (objData.PlayersIDHere) {
                    let nPlayers = countCurrentUsers(objData.PlayersIDHere);
                    let sPlayerLabel = (nPlayers > 1) ? "users" : "user";
                    if (document.getElementById('WhosHere'))
                        document.getElementById('WhosHere').innerHTML = g_objGame.WhosHere = "<span onclick='CheckConnection()'>" + nPlayers + " " + sPlayerLabel + "</span>";
                    g_objGame.id = objData.ID;
                    if (document.getElementById('NamesHere'))
                        document.getElementById('NamesHere').innerHTML = objData.PlayersNameList ? objData.PlayersNameList : "";
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
}
"""

new_post_code = """const postFileFromServer = async (url, sData, doneCallback) => {
    if (!window.firebaseBackend) {
        setTimeout(() => postFileFromServer(url, sData, doneCallback), 100);
        return;
    }
    if (sData.startsWith("SetData=")) {
        const jsonData = sData.substring(8);
        const objData = JSON.parse(jsonData);
        await window.firebaseBackend.setScore(objData.room, objData.player_id, objData.score);
        const data = await window.firebaseBackend.getRoomData(objData.room);
        doneCallback(data);
    } else if (sData.startsWith("GetRoomData=")) {
        const room = sData.substring(12);
        const data = await window.firebaseBackend.getRoomData(room);
        doneCallback(data);
    } else if (sData.startsWith("ClearRoom=")) {
        const room = sData.substring(10);
        await window.firebaseBackend.clearRoom(room);
        doneCallback("Successfully cleared room " + room);
    } else if (sData.startsWith("ClearTable=")) {
        await window.firebaseBackend.clearTable();
        doneCallback("Successfully cleared table");
    }
}
"""

# Replace 748 to 889 (0-indexed 748:890)
# Replace 1398 to 1410 (0-indexed 1398:1411)

lines = lines[:748] + [new_ws_code] + lines[890:1398] + [new_post_code] + lines[1411:]

with open("Score/Score.js", "w") as f:
    f.writelines(lines)


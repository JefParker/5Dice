 
"use strict";

var g_objScore = {}; // Specific Game
var g_objUserData = {};  // Player
var g_objGame = {}; // Temp
var wSocket = null;
var contextMenu = null;



onload = () => {
    GetUserData();
    SetUpData();
    SetGameData();
    ServiceWorkerReg();

    if ("" == g_objUserData.Name)
        ShowEnterID();
    else {
        CheckConnection();
        ShowScoreMain();
        askForNotificationApproval();
    }
}


const GetUserData = () => {
    let sData = localStorage.getItem("UserData");
    if (null != sData) {
        g_objUserData = JSON.parse(sData);
    } else {
        g_objUserData.Name = "";
        g_objUserData.PlayerID = MakeRandomCode(10);
        g_objUserData.GameID = getRandomInt(1, 99999);
        g_objUserData.Color = PickRandomColor();
        document.body.style.background = g_objUserData.Color;
    }
}


const SetUserData = () => {
    localStorage.setItem("UserData", JSON.stringify(g_objUserData));
}


const SetGameData = () => {
    g_objGame.Locked = true;
    g_objGame.Timer = null;
    g_objGame.ScoreSheetShowing = null;
    g_objGame.LeaderList = [];
    g_objGame.DiceRackShowing = false;
    g_objGame.ToastCounter = 0;
    g_objGame.LastMoveText = "";
    g_objGame.LastMoveToast = null;
}


const SetUpData = () => {
    let sData = localStorage.getItem(g_objUserData.GameID);
    g_objScore = {};
    g_objScore.dLastLoaded = new Date();
    g_objScore.dLastUpdate = new Date().valueOf();
    if (null != sData) {
        g_objScore = JSON.parse(sData);
        g_objScore.Color = g_objUserData.Color;
        g_objScore.Name = g_objUserData.Name;
    } else {
        g_objScore.Name = g_objUserData.Name;
        g_objScore.PlayerID = g_objUserData.PlayerID;
        g_objScore.Score =  [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null];
        document.body.style.background = g_objScore.Color = g_objUserData.Color;
    }
}


const ShowEnterID = () => {
    setSheetLocked();
    let sPage = "";
    sPage += "<div class='TitleBar'>5 Dice Score Sheet</div>";
    sPage += "<br><div class='Lobby' style = 'width: 80%; max-width: 400px; text-align: center;'>";
    sPage += "<br>";
    sPage += "<input type='number' id='GameID' placeholder='Room #'  class='GameSetupInputs'><br><br>";
    sPage += "<input type='text' id='PlayerName' placeholder='Your Name' class='GameSetupInputs' maxlength='10'><br><br>";
    sPage += "<div class='ColorBtn' onclick='colorBtn()'>Color";

    sPage += "<div class='ColorPickerContainer' style='display: none;'>";
    sPage += "<input type='color' id='bgcolor' list='presetColors' tooltip='Color picker' value="+g_objUserData.Color+">";
    sPage += "</div>";

    sPage += "</div><br><br>";
    sPage += "<input type='button' value='Go' id='Go' class='GameSetupInputs WordReveal' style='width: 40%;' onclick='IDGo()'>";


    sPage += "<datalist id='presetColors'><option value='#235880'/><option value='#3F1F74'/><option value='#6F4F1F'/><option value='#2E2B53'/><option value='#264C1C'/><option value='#533A51'/><option value='#220066'/><option value='#181B59'/><option value='RebeccaPurple'/><option value='#404040'/></datalist>";

    sPage += "</div>";
    document.getElementById('Main').innerHTML = sPage;

    document.getElementById('GameID').value = g_objUserData.GameID;
    document.getElementById('bgcolor').value = g_objUserData.Color;
    document.body.style.background = g_objUserData.Color;

    if (g_objUserData.Name) {
        document.getElementById('PlayerName').value = g_objUserData.Name;
        document.getElementById('GameID').value = g_objUserData.GameID;
    }

    document.getElementById('Go').focus();

    document.getElementById('bgcolor').addEventListener("input", function(){
            g_objUserData.Color = g_objScore.Color = document.getElementById('bgcolor').value;
            document.body.style.background = g_objUserData.Color;
        }, false);
}

const colorBtn = () => {
    if (isIos()) {
        let sColor = PickRandomColor();
        g_objUserData.Color = g_objScore.Color = sColor;
        document.body.style.background = g_objUserData.Color;
    } else {
        document.getElementById('bgcolor').showPicker();
    }
}


const IDGo = () => {
    let nGameID = document.getElementById('GameID').value.trim();
    if (g_objUserData.GameID != nGameID) {
        g_objUserData.GameID = nGameID;
        initWebSocket();
        g_objGame.LeaderList = [];
        setTimeout(function() {BCastRequestScores();}, 2000);
    }

    g_objUserData.Name = g_objScore.Name = document.getElementById('PlayerName').value.trim();
    SetGameID(g_objUserData.GameID);

    if (!g_objUserData.GameID) {
        alert ("Please enter a room number");
        return;
    }
    if (g_objUserData.Name.length < 3) {
        alert ("Please enter a player name");
        return;
    }

    SetUserData();
    SetUpData();
    ShowScoreMain();

    localStorage.setItem(g_objUserData.GameID, JSON.stringify(g_objScore));

}

const ShowScoreMain = () => {
    let sPage = "";

    sPage += "<div id='Upper' class='Third'>";

    sPage += "<div id='TitleBar' class='TitleBar'>" + g_objScore.Name + "'s Score Sheet";
    sPage += "</div>";

    sPage += "<div id='USRow1' class='QuarterRow'>";
    sPage += "<div id='US1_1' class='DiceBox' onclick='EnterScore(\"1\")' title='Value is total number of ones'>";
    sPage += "<div class='HalfDiceBox'>\u2680</div>";
    sPage += "<div class='HalfDiceBox' id='Ones'> </div>";
    sPage += "</div>";

    sPage += "<div id='US1_2' class='DiceBox' onclick='EnterScore(\"4\")' title='Value is total number of fours'>";
    sPage += "<div class='HalfDiceBox'>\u2683</div>";
    sPage += "<div class='HalfDiceBox' id='Fours'> </div>";
    sPage += "</div>";
    sPage += "</div>";

    sPage += "<div id='USRow2' class='QuarterRow'>";
    sPage += "<div id='US2_1' class='DiceBox' onclick='EnterScore(\"2\")' title='Value is total number of twos'>";
    sPage += "<div class='HalfDiceBox'>\u2681</div>";
    sPage += "<div class='HalfDiceBox' id='Twos'> </div>";
    sPage += "</div>";

    sPage += "<div id='US2_2' class='DiceBox' onclick='EnterScore(\"5\")' title='Value is total number of fives'>";
    sPage += "<div class='HalfDiceBox'>\u2684</div>";
    sPage += "<div class='HalfDiceBox' id='Fives'> </div>";
    sPage += "</div>";
    sPage += "</div>";

    sPage += "<div id='USRow3' class='QuarterRow'>";
    sPage += "<div id='US3_1' class='DiceBox' onclick='EnterScore(\"3\")' title='Value is total number of threes'>";
    sPage += "<div class='HalfDiceBox'>\u2682</div>";
    sPage += "<div class='HalfDiceBox' id='Threes'> </div>";
    sPage += "</div>";

    sPage += "<div id='US3_2' class='DiceBox' onclick='EnterScore(\"6\")' title='Value is total number of sixes'>";
    sPage += "<div class='HalfDiceBox'>\u2685</div>";
    sPage += "<div class='HalfDiceBox'id='Sixes'> </div>";
    sPage += "</div>";
    sPage += "</div>";

    sPage += "<div id='USRow4' class='TwentiethRow'>";
    sPage += "<div id='US4_1' class='HalfRow'>Total <span id='U'>0</span> (<span id='Par'>on par</span>)</div>";
    sPage += "<div id='US4_2' class='HalfRow'>Bonus (if > 62): <span id='UB'>0</span></div>";
    sPage += "</div>";

    sPage += "<div id='USRow5' class='TwentiethRow'>";
    sPage += "";
    sPage += "</div>";

    sPage += "</div>"; // end Upper

    sPage += "<div id='Lower' class='Third'>";

    sPage += "<div id='LSRow1' class='EighthRow'>";
    sPage += "<div class='HalfRow' onclick='EnterScore(\"C\")'>";
    sPage += "<div class='LowerLineBoxL' id='Chance'>Chance</div>";


    sPage += "<div class='LowerLineBoxR' id='C'> </div>";
    sPage += "</div>";

    sPage += "<div class='HalfRow' onclick='EnterScore(\"SS\")'>";
    sPage += "<div class='LowerLineBoxL'>Sm Str</div>";
    sPage += "<div class='LowerLineBoxR' id='SS'> </div>";
    sPage += "</div>";
    sPage += "</div>";

    sPage += "<div id='LSRow2' class='EighthRow'>";
    sPage += "<div class='HalfRow' onclick='EnterScore(\"TK\")'>";
    sPage += "<div class='LowerLineBoxL'>3 of a Kind</div>";
    sPage += "<div class='LowerLineBoxR' id='3K'> </div>";
    sPage += "</div>";

    sPage += "<div class='HalfRow' onclick='EnterScore(\"LS\")'>";
    sPage += "<div class='LowerLineBoxL'>Lg Str</div>";
    sPage += "<div class='LowerLineBoxR' id='LS'> </div>";
    sPage += "</div>";
    sPage += "</div>";

    sPage += "<div id='LSRow3' class='EighthRow'>";
    sPage += "<div class='HalfRow' onclick='EnterScore(\"FK\")'>";
    sPage += "<div class='LowerLineBoxL'>4 of a Kind</div>";
    sPage += "<div class='LowerLineBoxR'id='4K'> </div>";
    sPage += "</div>";

    sPage += "<div class='HalfRow' onclick='EnterScore(\"FD\")'>";
    sPage += "<div class='LowerLineBoxL'>5 Dice</div>";
    sPage += "<div class='LowerLineBoxR' id='FD'> </div>";
    sPage += "</div>";
    sPage += "</div>";


    sPage += "<div id='LSRow4' class='EighthRow'>";
    sPage += "<div class='HalfRow' onclick='EnterScore(\"FH\")'>";
    sPage += "<div class='LowerLineBoxL'>Full House</div>";
    sPage += "<div class='LowerLineBoxR' id='FH'> </div>";
    sPage += "</div>";

    sPage += "<div class='HalfRow'onclick='EnterScore(\"B5\")'>";
    sPage += "<div class='LowerLineBoxL'>Bonus 5's</div>";
    sPage += "<div class='LowerLineBoxR' id='B5'> </div>";
    sPage += "</div>";
    sPage += "</div>";

    sPage += "<div id='LSRow5' class='TwentiethRow'>";
    sPage += "<div id='USTot' class='HalfRow'>Upper Total: <span id='UTot'>0</span></div>";
    sPage += "<div id='LSTot' class='HalfRow'>Lower Total: <span id='LTot'>0</span></div>";
    sPage += "</div>";

    sPage += "<div id='LSRow6' class='GrandTotalRow'>";
    sPage += "<b>Grand Total: <div id='GTot' class='GTot'>0</div></b>";
    sPage += "</div>"

    sPage += "<div id='LSRow7' class='LockSheetRow'>";
    sPage += "<br>";

    sPage += "<label class='p-form-switch'><input type='checkbox' id='Lock' onclick='toggleLock()'><span></span></label>";
    sPage += "<label for='Lock' class='CheckBoxLbl'> <span id='LockLabel'>Locked</span></label><div id='Turns'>13 turns remaining</div>";
    //  onclick='ColorToast(\"test\", \"maroon\")'
    sPage += "</div>"

    sPage += "</div>";

    sPage += "<div id='Summary' class='Third'>";
    sPage += "<div id='GameInfo1' class='FifthRow'>";

    sPage += "<div class='GameInfoBoxL'>";
    sPage += "<div onclick='ShowEnterID()'>Room: " + g_objUserData.GameID + "</div>";
    sPage += "<div id='PlayerName' onclick='ShowEnterID()'>"+g_objScore.Name+"</div>";
    sPage += "</div>"

    sPage += "<div class='GameInfoBoxR'>";
    sPage += "<div id='WhosHere'>";
    sPage += g_objGame.WhosHere ? g_objGame.WhosHere : "";
    sPage += "</div>";
    sPage += "<div id='NamesHere'>";
    sPage += g_objGame.NamesHere ? g_objGame.NamesHere : "";
    sPage += "</div>";
    sPage += "</div>"

    sPage += "<div id='ClearBtn' class='ClearBtn' onclick='Clear()'>Clear</div>";

    sPage += "</div>";  // end FifthRow

    sPage += "<div class='LeaderBoard'><span onclick='RequestLeaderBoard()'>Leader Board</span>";
    sPage += "<div id='LeaderBoardEntries' class='LeaderBoardEntries'></div>";
    sPage += "</div>";
    sPage += "</div>";

    sPage += "<div id='Toast0' class='Toast'></div>";
    sPage += "<div id='Toast1' class='Toast'></div>";
    sPage += "<div id='Toast2' class='Toast'></div>";
    sPage += "<div id='DialogBox' class='DialogBox'></div>";
    sPage += "<div id='DiceRack' class='DiceRack'><div id='RollingDice' class='RollingDice'>\u2680 \u2680 \u2680 \u2680 \u2680</div>";

    sPage += "</div>"; // end Summary third

    sPage += MakeContextMenuHTML("");

    document.getElementById('Main').innerHTML = sPage;

    InitializeContextMenu("");

    if (g_objScore) {
        DisplayScore(g_objScore);
    }

    setTimeout(BCastRequestScores, 2000);
}

const toggleLock = () => {
    if (document.getElementById("Lock").checked) {
        document.getElementById("LockLabel").innerHTML = "Unlocked";
        g_objGame.Locked = false;
        DisplayScore(g_objScore);
        g_objGame.Timer = setTimeout(setSheetLocked, 30000);
        let nTurns = TurnsRemaining(g_objScore);
        if (0 == nTurns) {
            document.getElementById('ClearBtn').style.borderWidth = null;
        }
    } else {
        document.getElementById("LockLabel").innerHTML = "Locked";
        g_objGame.Locked = true;
        clearTimeout(g_objGame.Timer);
        g_objGame.Timer = null;
        document.getElementById('ClearBtn').style.borderWidth = '0px';
    }
}

const setSheetLocked = () => {
    g_objGame.Locked = true;
    clearTimeout(g_objGame.Timer);
    g_objGame.Timer = null;
    if (null == document.getElementById("Lock"))
        return;
    document.getElementById("Lock").checked = false;
    document.getElementById("LockLabel").innerHTML = "Locked";
    document.getElementById('ClearBtn').style.borderWidth = '0px';
}

const setSheetUnLocked = () => {
    g_objGame.Locked = false;
    clearTimeout(g_objGame.Timer);
    g_objGame.Timer = null;
    if (null == document.getElementById("Lock"))
        return;
    document.getElementById("Lock").checked = true;
    document.getElementById("LockLabel").innerHTML = "Unlocked";
    let nTurns = TurnsRemaining(g_objScore);
    if (0 == nTurns) {
        document.getElementById('ClearBtn').style.borderWidth = null;
    }
}

const EnterScore = (sClicked) => {
    if (g_objGame.Locked)
        return;
    let nClicked = parseInt(sClicked);

    if (nClicked < 7) {
        if (null == g_objScore.Score[nClicked-1])
            g_objScore.Score[nClicked-1] = 0;
        else
            g_objScore.Score[nClicked-1] = nClicked + g_objScore.Score[nClicked-1];

        if (g_objScore.Score[nClicked-1] > nClicked * 5)
            g_objScore.Score[nClicked-1] = null;

        if (null != g_objScore.Score[nClicked-1])
            LagSendLastMoveToast(g_objScore.Score[nClicked-1] + " on " + nClicked + "'s");


        let nUTotal = 0;
        for (let x = 0; x<6; x++) {
            nUTotal += g_objScore.Score[x];
        }
        g_objScore.Score[14] = (nUTotal > 62) ? 35 : 0;
    }
    else if ("C" == sClicked) {
        if (null == g_objScore.Score[6])
            DialogBox("Chance", "C");
        else
            g_objScore.Score[6] = null;
    }
    else if ("TK" == sClicked) {
        if (null == g_objScore.Score[7])
            DialogBox("3 of a kind", "TK");
        else
            g_objScore.Score[7] = null;
    }
    else if ("FK" == sClicked) {
        if (null == g_objScore.Score[8])
            DialogBox("4 of a kind", "FK");
        else
            g_objScore.Score[8] = null;
    }
    else if ("FH" == sClicked) {
        if (null == g_objScore.Score[9])
            g_objScore.Score[9] = 0;
        else if (0 == g_objScore.Score[9])
            g_objScore.Score[9] = 25;
        else
            g_objScore.Score[9] = null;
        if (null != g_objScore.Score[9])
            LagSendLastMoveToast(g_objScore.Score[9] + " on full house");
    }
    else if ("SS" == sClicked) {
        if (null == g_objScore.Score[10])
            g_objScore.Score[10] = 0;
        else if (0 == g_objScore.Score[10])
            g_objScore.Score[10] = 30;
        else
            g_objScore.Score[10] = null;
        if (null != g_objScore.Score[10])
            LagSendLastMoveToast(g_objScore.Score[10] + " on small straight");
    }
    else if ("LS" == sClicked) {
        if (null == g_objScore.Score[11])
            g_objScore.Score[11] = 0;
        else if (0 == g_objScore.Score[11])
            g_objScore.Score[11] = 40;
        else
            g_objScore.Score[11] = null;
        if (null != g_objScore.Score[11])
            LagSendLastMoveToast(g_objScore.Score[11] + " on large straight");
    }
    else if ("FD" == sClicked) {
        if (null == g_objScore.Score[12])
            g_objScore.Score[12] = 0;
        else if (0 == g_objScore.Score[12])
            g_objScore.Score[12] = 50;
        else
            g_objScore.Score[12] = null;
        if (null != g_objScore.Score[12])
            LagSendLastMoveToast(g_objScore.Score[12] + " on 5 Dice");
    }
    else if ("B5" == sClicked) {
        if (null == g_objScore.Score[13])
            g_objScore.Score[13] = 0;
        else
            g_objScore.Score[13] += 100;
        if (g_objScore.Score[13] > 900)
            g_objScore.Score[13] = null;
    }

    let nUTotal = 0;
    for (let x = 0; x<6; x++) {
        nUTotal += g_objScore.Score[x];
    }
    g_objScore.Score[15] = nUTotal;

    let nLTotal = 0;
    for (let y = 6; y<14; y++) {
        nLTotal += g_objScore.Score[y];
    }
    g_objScore.Score[16] = nLTotal;
    g_objScore.Score[17] = nLTotal + nUTotal + g_objScore.Score[14];

    g_objScore.dLastUpdate = new Date().valueOf();

    DisplayScore(g_objScore);
    BCastScore(JSON.stringify(g_objScore));
    BCastNotification('Score', g_objScore.Name + ' scored');

    localStorage.setItem(g_objUserData.GameID, JSON.stringify(g_objScore));

    SendScoreToServerDB();

}


const SendScoreToServerDB = () => {

    let objData = {};
    objData.room = g_objUserData.GameID;
    objData.player_id = g_objUserData.PlayerID;
    objData.score = JSON.stringify(g_objScore);

    let jsonData = JSON.stringify(objData);
    console.log("Sending: " + jsonData);
    postFileFromServer("api", "SetData=" + jsonData, setDataCallback);
    function setDataCallback(data) {
        if (data) {
            console.log(data);
            g_objGame.LeaderList = [];
            objData = JSON.parse(data);
            for (let d=0; d<objData.length; d++)
            {
                LeaderList(objData[d].score);
            }
            DisplayScore(g_objScore);
        }
    }
}

const GetScoresFromServerDB = () => {

    let objData = {};

    postFileFromServer("api", "GetRoomData=" + g_objUserData.GameID, getDataCallback);
    function getDataCallback(data) {
        if (data) {
            console.log(data);
            objData = JSON.parse(data);
            g_objGame.LeaderList = [];
            for (let d=0; d<objData.length; d++)
            {
                LeaderList(objData[d].score);
            }
            DisplayScore(g_objScore);
        }
    }
}

const ClearRoomInServerDB = () => {

    postFileFromServer("api", "ClearRoom=" + g_objUserData.GameID, clearRoomCallback);
    function clearRoomCallback(data) {
        if (data) {
            g_objGame.LeaderList = [];
            DisplayScore(g_objScore);
            alert(data);
        }
    }
}

const ClearAllRoomsInServerDB = () => {
    if ("Jeff" != g_objUserData.Name)
        return false;
    postFileFromServer("api", "ClearTable=" + true, clearAllRoomsCallback);
    function clearAllRoomsCallback(data) {
        if (data) {
            g_objGame.LeaderList = [];
            DisplayScore(g_objScore);
            alert(data);
        }
    }
}

const DisplayScore = (objData) => {

    // Keep track of whose scoresheet is being displayed
    g_objGame.ScoreSheetShowing = objData.PlayerID;

    document.getElementById("Ones").innerHTML = objData.Score[0];
    document.getElementById("Twos").innerHTML = objData.Score[1];
    document.getElementById("Threes").innerHTML = objData.Score[2];
    document.getElementById("Fours").innerHTML = objData.Score[3];
    document.getElementById("Fives").innerHTML = objData.Score[4];
    document.getElementById("Sixes").innerHTML = objData.Score[5];

    document.getElementById("C").innerHTML = objData.Score[6];
    document.getElementById("3K").innerHTML = objData.Score[7];
    document.getElementById("4K").innerHTML = objData.Score[8];
    document.getElementById("FH").innerHTML = objData.Score[9];
    document.getElementById("SS").innerHTML = objData.Score[10];
    document.getElementById("LS").innerHTML = objData.Score[11];
    document.getElementById("FD").innerHTML = objData.Score[12];
    document.getElementById("B5").innerHTML = objData.Score[13];
    document.getElementById("UB").innerHTML = objData.Score[14];

    document.getElementById("U").innerHTML = objData.Score[15];
    document.getElementById("UTot").innerHTML = objData.Score[14] + objData.Score[15];

    document.getElementById("Par").innerHTML = CheckPar(objData);

    document.getElementById("LTot").innerHTML = objData.Score[16];
    document.getElementById("GTot").innerHTML = "<div class='GTot'>" + Number(objData.Score[17]) + "</div>";

    document.getElementById("LeaderBoardEntries").innerHTML = LeaderList(JSON.stringify(objData));
    document.getElementById("TitleBar").innerHTML = objData.Name + "'s Score Sheet";

    document.body.style.background = objData.Color;

    let nTurns = TurnsRemaining(objData);
    document.getElementById('ClearBtn').style.borderWidth = '0px';
    if (0 == nTurns) {
        releaseWakeState();
        document.getElementById("Turns").innerHTML = "<div class='Turns'><b>Game Over</b></div>";
        document.getElementById('ClearBtn').style.borderWidth = null;
    }
    else if (1 == nTurns) {
        document.getElementById("Turns").innerHTML = nTurns + " turn remaining";
    } else {
        document.getElementById("Turns").innerHTML = nTurns + " turns remaining";
        lockWakeState();
    }
}

const LeaderList = (sData) => {
    //console.log(sData);
    let objData = JSON.parse(sData);

    let sLeaderList = "";
    let bFound = false;
    let x=0;
    for (x=0; x<g_objGame.LeaderList.length; x++) {
        if (g_objGame.LeaderList[x].PlayerID == objData.PlayerID) {
            if (g_objGame.LeaderList[x].dLastUpdate < objData.dLastUpdate)
                g_objGame.LeaderList[x] = objData;
            bFound = true;
        }
    }
    if (!bFound) {
        g_objGame.LeaderList[x] = objData;
    }

    g_objGame.LeaderList.sort(sort_by_score);

    sLeaderList = "<div class='LeaderBoardEntries'>";
    for (x=0; x<g_objGame.LeaderList.length; x++) {
        if (null != g_objGame.LeaderList[x].Score[17]) {
            let nTurns = TurnsRemaining(g_objGame.LeaderList[x]);
            sLeaderList +=  "<div onclick='LoadScore(\"" + g_objGame.LeaderList[x].PlayerID + "\")'>" + g_objGame.LeaderList[x].Name;
            if (nTurns)
                sLeaderList += " ("+nTurns+")";
            sLeaderList += ": " +  g_objGame.LeaderList[x].Score[17] + "</div>";
        }
    }
    sLeaderList += "</div>";

    let nPlayers = g_objGame.LeaderList.length;
    let sPlayerLabel = (nPlayers > 1) ? "users" : "user";
    if (document.getElementById('WhosHere')) {
        document.getElementById('WhosHere').innerHTML = g_objGame.WhosHere = "<span onclick='CheckConnection()'>" + nPlayers + " " + sPlayerLabel + "</span>";
    }

    return sLeaderList;
}

const FindColorbyName = (objData) => {
    let x=0;
    for (x=0; x<g_objGame.LeaderList.length; x++) {
        if (g_objGame.LeaderList[x].Name == objData.Name) {
            return g_objGame.LeaderList[x].Color;
        }
    }
    return "#404040";
}

const LoadScore = (sPlayerID) => {
    for (let x=0; x<g_objGame.LeaderList.length; x++) {
        if (g_objGame.LeaderList[x].PlayerID == sPlayerID) {
            DisplayScore(g_objGame.LeaderList[x]);
            setSheetLocked();
            break;
        }
    }
}

var sort_by_score = function (a, b) {
	return b.Score[17] - a.Score[17];
};

const MakeDiceRollPossiblities = () => {
	let sRolls = "";
	for (let x=5; x < 31; x++) {
		sRolls += "<option value='"+x+"'>"+x+"</option>";
	}
	return sRolls;
}

const TurnsRemaining = (objData) => {
    let nTurnsRemaining = 0;
    for (let x = 0; x<13; x++) {
        if (null == objData.Score[x])
            nTurnsRemaining++;
    }
    return nTurnsRemaining;
}

const CheckPar = (objData) => {
    let aPar = [3, 6, 9, 12, 15, 18];
    let nPar = 0;
    for (let i=0; i<6; i++) {
        if (null !== objData.Score[i])
            nPar += (objData.Score[i] - aPar[i]);
    }
    let sPar = '';
    if (0==nPar)
        return 'on par';
    else if (nPar > 0)
        return nPar + ' above';
    else if (nPar < 0)
        return Math.abs(nPar) + ' under';
}

const Clear = () => {
    if (g_objGame.Locked)
        return;
    if (confirm("Are you sure you want to clear the score sheet?")) {
        g_objScore.Score =  [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null];
        g_objGame.LeaderList = [];
        DisplayScore(g_objScore);
        BCastScore(JSON.stringify(g_objScore));
        BCastNotification('Score', g_objScore.Name + ' cleared score sheet');
        BCastToast(g_objScore.Name + ' cleared sheet', g_objScore.Color);
        setSheetLocked();
        localStorage.setItem(g_objUserData.GameID, JSON.stringify(g_objScore));
        document.getElementById('ClearBtn').style.borderWidth = '0px';
        SendScoreToServerDB();
    }
}

const DialogBox = (sMess, sCat) => {
    let sDlg = sMess + "<div><select id='Sel' class='DiceSumEntry' onchange='CloseDlg(\""+sCat+"\")'><option value=''> </option>";
    if ("TK" == sCat || "FK" == sCat)
    sDlg += "<option value='0'>0</option>";
    sDlg += MakeDiceRollPossiblities();
    sDlg += "</select></div>";
	document.getElementById('DialogBox').innerHTML = "<div class='DialogBoxMsg';>"+sDlg+"</div>";
    setSheetUnLocked();
    document.getElementById('Sel').focus();
}

const CloseDlg = (sCat) => {
    if ("C" == sCat) {
        g_objScore.Score[6] = parseInt(document.getElementById('Sel').value);
        LagSendLastMoveToast(g_objScore.Score[6] + " on chance");
    }
    else if ("TK" == sCat) {
        g_objScore.Score[7] = parseInt(document.getElementById('Sel').value);
        LagSendLastMoveToast(g_objScore.Score[7] + " on 3 of a kind");
    }
    else if ("FK" == sCat) {
        g_objScore.Score[8] = parseInt(document.getElementById('Sel').value);
        LagSendLastMoveToast(g_objScore.Score[8] + " on 4 of a kind");
    }
    document.getElementById('DialogBox').innerHTML = '';
    EnterScore('X');
    setSheetLocked();
}


/* Start WebSocket Code */
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

let countCurrentUsers = (sIDs) => {
    console.log(sIDs);
    let aIDs = sIDs.split(",");
    return aIDs.length;
}

var hidden, visibilityChange;
VisiblitySetup();

function VisiblitySetup() {
    if (typeof document.hidden !== "undefined") { // Opera 12.10 and Firefox 18 and later support
        hidden = "hidden";
        visibilityChange = "visibilitychange";
    } else if (typeof document.msHidden !== "undefined") {
        hidden = "msHidden";
        visibilityChange = "msvisibilitychange";
    } else if (typeof document.webkitHidden !== "undefined") {
        hidden = "webkitHidden";
        visibilityChange = "webkitvisibilitychange";
    }
    document.addEventListener(visibilityChange, ShowVisibilityChange, false);
}

function ShowVisibilityChange() {
    if ('visible' === document.visibilityState) {
        if (isIos() && !isInStandaloneMode()) {
            let now = new Date();
            let elapsed = now.valueOf() - g_objScore.dLastLoaded.valueOf();
            console.log("iOS:  " + elapsed + "ms since visible");
            if (elapsed > 3600000)
                window.location.reload();
            // BCastRequestLeaderBoard();
        } else {
            console.log("Not iOS");
        }
        GetScoresFromServerDB();
        CheckConnection();
        // BCastRequestScores();
        BCastRequestLeaderBoard();
    }
    else if ('hidden' === document.visibilityState) {
        g_objScore.dLastLoaded = new Date();
    }
}

let SendMyID = () => {
    let objData = {};
    objData.Type = "Score";
    objData.GameID = 0;
    objData.Message = "MyID";
    objData.ID = 0; // Zero means socket gives ID number
    objData.Name = g_objScore.Name ? g_objScore.Name : "Score";
    //objData.UserName = QueryString.ID;
    objData.Event = "AssociateID";
    let jsonData = JSON.stringify(objData);
    sendMessage(jsonData);
}

const SetGameID = (nGameID) => {
    let objData = {};
    objData.Type = "Score";
    objData.Message = "SetGameID";
    objData.GameID = parseInt(nGameID);
    objData.ID = parseInt(g_objGame.id);
    let jsonData = JSON.stringify(objData);
    sendMessage(jsonData);
}

const BCastNotification = (sTitle, sText) => {
    let objData = {};
    objData.Message = "BCast2Game";
    objData.Type = "Score";
    objData.GameID = parseInt(g_objUserData.GameID);
    objData.ID = parseInt(g_objGame.id);
    objData.Event = "Notification";
    objData.Title = sTitle;
    objData.Text = sText;
    let jsonData = JSON.stringify(objData);
    sendMessage(jsonData);
}

const BCastToast = (sText, sColor) => {
    let objData = {};
    objData.Message = "BCast2Game";
    objData.Type = "Score";
    objData.GameID = parseInt(g_objUserData.GameID);
    objData.ID = parseInt(g_objGame.id);
    objData.Event = "Toast";
    objData.Text = sText;
    objData.Color = sColor;
    let jsonData = JSON.stringify(objData);
    sendMessage(jsonData);
}

const BCastScore = (sPlayer) => {
    let objData = {};
    objData.Message = "BCast2Game";
    objData.Type = "Score";
    objData.GameID = parseInt(g_objUserData.GameID);
    objData.ID = parseInt(g_objGame.id);
    objData.Event = "UpdateScore";
    objData.Player = sPlayer;
    let jsonData = JSON.stringify(objData);
    sendMessage(jsonData);
}

const BCastRequestScores = () => {
    let objData = {};
    objData.Message = "BCast2Game";
    objData.Type = "Score";
    objData.GameID = parseInt(g_objUserData.GameID);
    objData.ID = parseInt(g_objGame.id);
    objData.Event = "RequestScore";
    let jsonData = JSON.stringify(objData);
    sendMessage(jsonData);
}

const SendScore2ID = (ID, sPlayer) => {
    let objData = {};
    objData.ToID = parseInt(ID);
    objData.Message = "Msg2ID";
    objData.Type = "Score";
    objData.GameID = parseInt(g_objUserData.GameID);
    objData.Event = "UpdateScore";
    objData.ID = parseInt(g_objGame.id);
    objData.Player = sPlayer;
    let jsonData = JSON.stringify(objData);
    sendMessage(jsonData);
}


const RequestLeaderBoard = () => {
    GetScoresFromServerDB();
    BCastRequestLeaderBoard();
}

const BCastRequestLeaderBoard = () => {
    let objData = {};
    objData.Message = "BCast2Game";
    objData.Type = "Score";
    objData.GameID = parseInt(g_objUserData.GameID);
    objData.ID = parseInt(g_objGame.id);
    objData.Event = "RequestLeaderBoard";
    let jsonData = JSON.stringify(objData);
    sendMessage(jsonData);
}

const SendLeaderBoard2ID = (ID, sLeaderBoard) => {
    let objData = {};
    objData.ToID = parseInt(ID);
    objData.Message = "Msg2ID";
    objData.Type = "Score";
    objData.GameID = parseInt(g_objUserData.GameID);
    objData.Event = "UpdateLeaderBoard";
    objData.ID = parseInt(g_objGame.id);
    objData.LeaderBoard = sLeaderBoard;
    let jsonData = JSON.stringify(objData);
    sendMessage(jsonData);
}

const LagSendLastMoveToast = (sScoreLine) => {
    g_objGame.LastMoveText = g_objScore.Name + ": " + sScoreLine;
    if (g_objGame.LastMoveToast)
        clearTimeout(g_objGame.LastMoveToast);
     g_objGame.LastMoveToast = setTimeout(SendLastMoveToast, 4000);

}

const SendLastMoveToast = () => {
    BCastToast(g_objGame.LastMoveText, g_objScore.Color);
}


const getRandomInt = (min, max) => {
	var rval = 0;
	var range = max - min;
	var bits_needed = Math.ceil(Math.log2(range));
	if (bits_needed > 53) {
		throw new Exception("We cannot generate numbers larger than 53 bits.");
	}
	var bytes_needed = Math.ceil(bits_needed / 8);
	var mask = Math.pow(2, bits_needed) - 1;
	// 7776 -> (2^13 = 8192) -1 == 8191 or 0x00001111 11111111

	// Create byte array and fill with N random numbers
	var byteArray = new Uint8Array(bytes_needed);
	window.crypto.getRandomValues(byteArray);
	var p = (bytes_needed - 1) * 8;
	for(var i = 0; i < bytes_needed; i++ ) {
		rval += byteArray[i] * Math.pow(2, p);
		p -= 8;
	}
	// Use & to apply the mask and reduce the number of recursive lookups
	rval = rval & mask;
	if (rval >= range) {
		// Integer out of acceptable range
		return getRandomInt(min, max);
	}
	// Return an integer that falls within the range
	return min + rval;
}

const GetRandomCharacter = () => {
  let sChar = new Array ("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9");
    //"-", "~", "!", "^", "*", "(", ")", "_", "<", ">", "|");
  return sChar[getRandomInt(0, sChar.length-1)];
}

const MakeRandomCode = (nDigits) => {
	var sCode = '';
	for (var i=0; i<nDigits; i++) {
		sCode += GetRandomCharacter();
	}
	return sCode;
}

const setCookie = (c_name, value, exdays) => {
    var exdate=new Date();
    exdate.setDate(exdate.getDate() + exdays);
    var c_value=escape(value) + ((exdays===null) ? '' : '; expires='+exdate.toUTCString());
    document.cookie=c_name + '=' + c_value + "; SameSite=Strict";
}

const getCookie = (c_name) => {
  var i,x,y,ARRcookies = document.cookie.split(';');
  for (i=0;i<ARRcookies.length;i++) {
    x=ARRcookies[i].substr(0,ARRcookies[i].indexOf('='));
    y=ARRcookies[i].substr(ARRcookies[i].indexOf('=')+1);
    x=x.replace(/^\s+|\s+$/g,'');
    if (x===c_name)
      return unescape(y);
  }
}


// Check if the browser supports the beforeinstallprompt event
if ('serviceWorker' in navigator && 'BeforeInstallPromptEvent' in window) {
    window.addEventListener('load', () => {
        // Wait for the beforeinstallprompt event
        window.addEventListener('beforeinstallprompt', (event) => {
            // Prevent the default "Add to Home Screen" prompt
            event.preventDefault();

            // Automatically show the "Add to Home Screen" prompt on page load
            event.prompt();
        });
    });
}


// Detects if device is on iOS
const isIos = () => {
  const userAgent = window.navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test( userAgent );
}
// Detects if device is in standalone mode
const isInStandaloneMode = () => ('standalone' in window.navigator) && (window.navigator.standalone);

// Checks if should display install popup notification:
if (isIos() && !isInStandaloneMode()) {
  //this.setState({ showInstallMessage: true });
}







/* const showNotification = (title, text) => {
    if ('granted' === Notification.permission) {
        const options = {
            title: title,
            body: text,
            icon: 'img/SyncWatch64.png',
            badge: 'img/SyncWatch64.png',
            tag: title,
            lang: 'en-US',
            vibrate: [100, 50, 100],
            data: {primaryKey: 1},
            actions: [{action: 'go', title: 'Go to game', icon: 'img/SyncWatch64.png'}]
        };
        navigator.serviceWorker.getRegistration()
                .then(reg => {
                reg.showNotification(title, options);
            });
    }
} */


const MakeContextMenuHTML = (sWindowShowing) => {
    let sPage = "";
    sPage += "<ul class='context' id='context'>";
    sPage += "<li class='context-link' id='GameID'>";
    sPage += "<span class='context-label'>Settings</span>";
    sPage += "</li>";
    sPage += "<li class='context-link' id='About'>";
    sPage += "<span class='context-label'>About</span>";
    sPage += "</li>";
    sPage += "<li class='context-link' id='ToggleDice'>";
    sPage += "<span class='context-label'>Dice</span>";
    sPage += "</li>";
    sPage += "<li class='context-link' id='RefreshLeaderBoard'>";
    sPage += "<span class='context-label'>Refresh Leaders</span>";
    sPage += "</li>";
    sPage += "<li class='context-link' id='ClearAllRooms'>";
    sPage += "<span class='context-label'>Clear All Rooms</span>";
    sPage += "</li>";
    sPage += "<li class='context-link' id='ClearRoom'>";
    sPage += "<span class='context-label'>Clear Room</span>";
    sPage += "</li>";
    sPage += "<li class='context-link' id='GetRoomList'>";
    sPage += "<span class='context-label'>Get Room List</span>";
    sPage += "</li>";

    sPage += "</ul>";
    return sPage;
}

const InitializeContextMenu = (sWindowShowing) => {
    contextMenu = document.querySelector(".context");
    contextMenu.style.textAlign = 'left';

    document.querySelector("#ToggleDice").addEventListener("click", () => {

        if (document.getElementById('DiceRack')) {
            document.getElementById('DiceRack').style.visibility = g_objGame.DiceRackShowing ? null : 'visible';
        }

        g_objGame.DiceRackShowing = g_objGame.DiceRackShowing ? false : true;

        //ColorToast('Not yet implemented... ' + g_objGame.DiceRackShowing, "#533A51");

    });

    document.querySelector("#RefreshLeaderBoard").addEventListener("click", () => {
        //g_objGame.LeaderList = [];
        //DisplayScore(g_objScore);
        //BCastRequestScores();
        RequestLeaderBoard();
        BCastRequestLeaderBoard();
    });

    document.querySelector("#GameID").addEventListener("click", () => {
        ShowEnterID();
    });

    document.querySelector("#About").addEventListener("click", () => {
        alert("Score Sheet rev. v240225k");
    });

    document.querySelector("#ClearRoom").addEventListener("click", () => {
        if (confirm("Clear the room?"))
            ClearRoomInServerDB();
    });

    document.querySelector("#ClearAllRooms").addEventListener("click", () => {
        if (confirm("Clear all rooms?"))
            ClearAllRoomsInServerDB();
    });

    document.querySelector("#GetRoomList").addEventListener("click", () => {
        postFileFromServer("Score.php", "GetRoomList=" + true, getRoomListCallback);
        function getRoomListCallback(data) {
            if (data) {
                alert(data);
            }
        }
    });

    //GetRoomList = true


    document.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        updateMenuPositon(ev.clientX, ev.clientY);
        contextMenu.style.visibility = "visible";
    });

    document.addEventListener("click", () => {
        contextMenu.style.visibility = null;
        // document.getElementById('DiceRack').style.visibility = null;
    });
}

const updateMenuPositon = (x, y) => {
    const maxLeftValue = window.innerWidth - contextMenu.offsetWidth;
    const maxTopValue = window.innerHeight - contextMenu.offsetHeight;
    contextMenu.style.left = `${Math.min(maxLeftValue, x)}px`;
    contextMenu.style.top = `${Math.min(maxTopValue, y)}px`;
};


var wakelock = null;
const canWakeLock = () => 'wakeLock' in navigator;

const lockWakeState = async () => {
  if(!canWakeLock()) return;
  try {
    wakelock = await navigator.wakeLock.request();
    wakelock.addEventListener('release', () => {
      console.log('Screen Wake State Locked:', !wakelock.released);
    });
    console.log('Screen Wake State Locked:', !wakelock.released);
  } catch(e) {
    console.error('Failed to lock wake state with reason:', e.message);
  }
}


const releaseWakeState = () => {
  if(wakelock) wakelock.release();
  wakelock = null;
}

const PickRandomColor = () => {
    let aColors = ["#235880", "#3F1F74", "#6F4F1F", "#2E2B53", "#264C1C", "#533A51", "#220066", "#191970", "#4d004d", "#663399", "#8B4513", "#181B59", "#006652", "#006666", "#2E8B57", "#483D8B", "#008000", "#008080", "#800000", "#000080", "#A0522D", "#404040", "#404040"];
    let nRand = getRandomInt(0, aColors.length -1);
    return aColors[nRand];
}

// var QueryString = function() {
//   var query_string = {};
//   var query = window.location.search.substring(1);
//   var vars = query.split("&");
//   for (var i=0;i<vars.length;i++) {
//     var pair = vars[i].split("=");
//     	// If first entry with this name
//     if (typeof query_string[pair[0]] === "undefined") {
//       query_string[pair[0]] = pair[1];
//     	// If second entry with this name
//     } else if (typeof query_string[pair[0]] === "string") {
//       var arr = [ query_string[pair[0]], pair[1] ];
//       query_string[pair[0]] = arr;
//     	// If third or later entry with this name
//     } else {
//       query_string[pair[0]].push(pair[1]);
//     }
//   }
//     return query_string;
// } ();

const ServiceWorkerReg = () => {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('Score-sw.js')
        .then((reg) => console.log('service worker registered', reg))
        .catch((err) => console.log('service worker not registered', err));
    }
}

const ColorToast = (sMess, sBGColor) => {
    if (document.getElementById('Toast'+g_objGame.ToastCounter)) {
        document.getElementById('Toast'+g_objGame.ToastCounter).innerHTML = "<div class='ToastMsg' style='background-color: "+sBGColor+"'>"+sMess+"</div> ";

        if (g_objGame.ToastTime)
            clearTimeout(g_objGame.ToastTime);
        g_objGame.ToastTime = setTimeout(function(){g_objGame.ToastTime = null;}, 5000);
        g_objGame.ToastCounter = (g_objGame.ToastCounter > 1) ? 0 : g_objGame.ToastCounter+1;
    }
}

const askForNotificationApproval = () => {
    Notification.requestPermission().then((result) => {
    });
}

const showNotification = (title, text, bOnlyIfHidden) => {
    if (bOnlyIfHidden && 'visible' === document.visibilityState)
        return;

    if ('granted' === Notification.permission) {
        const options = {
            title: title,
            body: text,
            icon: 'img/Score64.png',
            badge: 'img/Score64.png',
            tag: title,
            lang: 'en-US',
            vibrate: [100, 50, 100],
            data: {primaryKey: 1},
            actions: [{action: 'go', title: 'Go to game', icon: 'img/Score64.png'}]
        };
        navigator.serviceWorker.getRegistration()
            .then(reg => {
                reg.showNotification(title, options);
            });
    }
//     Notification.requestPermission().then((result) => {
//         if ('granted' === result) {
//             if (g_objScore.Sound && g_objScore.g_sounds)
//                 g_objScore.g_sounds.PlayPop();
//             const notification = new Notification(title, {
//                 title: title,
//                 body: text,
//                 icon: '/img/Dice144.png',
//                 tag: title,
//                 vibrate: [100, 50, 100],
//                 data: {primaryKey: 1},
//                 actions: [{action: 'go', title: 'Go to game', icon: '/img/5Dice24.png'}]
//             })
//         }
//     })

}

const postFileFromServer = async (url, sData, doneCallback) => {
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

//let diceUnicode = ['\u2680', '\u2681', '\u2682', '\u2683', '\u2684', '\u2685'];

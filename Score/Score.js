 
"use strict";

var g_objScore = {}; // Specific Game
var g_objUserData = {};  // Player
var g_objGame = {}; // Temp
var wSocket = null;
var contextMenu = null;



onload = () => {
    GetUserData();

    // Check if room is encoded in the URL query string (e.g. ?room=143)
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room') || urlParams.get('roomID') || urlParams.get('GameID');
    let isViaShareLink = false;
    if (roomParam) {
        g_objUserData.GameID = parseInt(roomParam, 10) || roomParam;
        isViaShareLink = true;

        // Strip room query parameter from address bar to prevent going back to setup screen on page refresh
        if (window.history && window.history.replaceState) {
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }

    SetUpData();
    SetGameData();
    ServiceWorkerReg();

    if ("" == g_objUserData.Name || isViaShareLink)
        ShowEnterID();
    else {
        CheckConnection();
        ShowScoreMain();
        askForNotificationApproval();
        SendScoreToServerDB();
    }
}


const GetUserData = () => {
    let sData = localStorage.getItem("UserData");
    if (null != sData) {
        try { g_objUserData = JSON.parse(sData); } catch(e) { g_objUserData = {}; }
    } else {
        g_objUserData = {};
    }

    if (!g_objUserData.PlayerID) {
        g_objUserData.PlayerID = localStorage.getItem("timeline_user_id") || MakeRandomCode(10);
    }
    if (!g_objUserData.GameID) {
        g_objUserData.GameID = getRandomInt(1, 99999);
    }

    const sharedName = localStorage.getItem("playerName");
    const sharedColor = localStorage.getItem("playerColor");
    const sharedUuid = localStorage.getItem("timeline_user_id");

    if (sharedName) g_objUserData.Name = sharedName;
    if (sharedColor) g_objUserData.Color = sharedColor;
    if (sharedUuid) g_objUserData.PlayerID = sharedUuid;

    if (!g_objUserData.Color) g_objUserData.Color = PickRandomColor();
    if (g_objUserData.Name === undefined) g_objUserData.Name = "";

    document.body.style.background = g_objUserData.Color;
    SetUserData();
}


const SetUserData = () => {
    localStorage.setItem("UserData", JSON.stringify(g_objUserData));
    if (g_objUserData.Name !== undefined) localStorage.setItem("playerName", g_objUserData.Name);
    if (g_objUserData.Color) localStorage.setItem("playerColor", g_objUserData.Color);
    if (g_objUserData.PlayerID) localStorage.setItem("timeline_user_id", g_objUserData.PlayerID);
}

window.addEventListener('storage', (e) => {
    if (e.key === 'playerName' || e.key === 'playerColor' || e.key === 'UserData' || e.key === 'timeline_user_id') {
        // Remember who we were, then re-read shared identity from localStorage. The
        // Lobby's Settings screen writes timeline_user_id / UserData when you paste a
        // Player ID, and we want the open score sheet to follow that change live.
        const oldPlayerID = g_objUserData.PlayerID;
        GetUserData();
        const pNameInput = document.getElementById('PlayerName');
        if (pNameInput) pNameInput.value = g_objUserData.Name || '';
        const bgColorInput = document.getElementById('bgcolor');
        if (bgColorInput) bgColorInput.value = g_objUserData.Color || '#28a745';

        if (g_objUserData.PlayerID && oldPlayerID && g_objUserData.PlayerID !== oldPlayerID) {
            SwitchIdentity(oldPlayerID);
        }
    }
});

// Re-identify a live score sheet after the Player ID changed underneath us (e.g. the
// Lobby synced to another device's UUID). We leave the old identity's presence, tear
// down the old subscription, reset to a fresh sheet for the new identity, and
// reconnect — the server feed then adopts the new identity's existing sheet (if any)
// via the same newest-wins path used everywhere else. No page reload needed.
const SwitchIdentity = (oldPlayerID) => {
    // Only meaningful once the score view is actually on screen (its cells exist).
    // On the setup screen there's nothing live to migrate; the new ID is used when
    // the player joins.
    if (!document.getElementById("Ones")) return;

    if (window.firebaseBackend && window.firebaseBackend.leavePresence && oldPlayerID)
        window.firebaseBackend.leavePresence(g_objUserData.GameID, oldPlayerID);

    // Tear down the old identity's subscription + heartbeat.
    stopWebSocket();

    // Start from a blank sheet for the new identity (dLastUpdate 0 so it can never
    // clobber a real server sheet). The onValue feed will adopt the new identity's
    // actual sheet for this room if one exists.
    g_objScore = {
        Name: g_objUserData.Name,
        PlayerID: g_objUserData.PlayerID,
        Color: g_objUserData.Color,
        Score: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
        dLastUpdate: 0,
        dLastLoaded: new Date()
    };
    localStorage.setItem(g_objUserData.GameID, JSON.stringify(g_objScore));

    document.body.style.background = g_objUserData.Color;
    g_objGame.LeaderList = [];
    g_objGame.ScoreSheetShowing = g_objUserData.PlayerID;
    DisplayScore(g_objScore);

    // Reconnect under the new identity (registers new presence, restarts heartbeat,
    // resubscribes; the scores feed then syncs the new identity's sheet in).
    initWebSocket();

    if (typeof ColorToast === 'function')
        ColorToast("Player ID synced", g_objUserData.Color);
};


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
        // JSON.parse leaves dLastLoaded as a string; restore a real Date object so
        // the visibilitychange elapsed-time math (valueOf()) works. Preserve the
        // stored dLastUpdate — it reflects the last actual score change and is used
        // by LeaderList's newest-wins comparison.
        g_objScore.dLastLoaded = new Date();
        if (typeof g_objScore.dLastUpdate !== 'number')
            g_objScore.dLastUpdate = new Date().valueOf();
    } else {
        g_objScore.Name = g_objUserData.Name;
        g_objScore.PlayerID = g_objUserData.PlayerID;
        g_objScore.Score =  [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null];
        document.body.style.background = g_objScore.Color = g_objUserData.Color;
        // A brand-new blank sheet must never win the newest-wins comparison, or a
        // freshly-opened second tab (same PlayerID) would clobber an in-progress
        // sheet already on the server. dLastUpdate=0 means "no real data yet"; it
        // gets a real timestamp the moment an actual score is entered.
        g_objScore.dLastUpdate = 0;
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
            SetUserData();
        }, false);
}

const colorBtn = () => {
    if (isIos()) {
        let sColor = PickRandomColor();
        g_objUserData.Color = g_objScore.Color = sColor;
        document.body.style.background = g_objUserData.Color;
        SetUserData();
    } else {
        document.getElementById('bgcolor').showPicker();
    }
}


const IDGo = () => {
    let nGameID = parseInt(document.getElementById('GameID').value.trim(), 10);
    if (isNaN(nGameID) || nGameID <= 0) {
        alert("Please enter a valid room number");
        return;
    }
    nGameID = nGameID.toString();

    // Validate the player name BEFORE mutating state or sending anything to the server.
    let sName = document.getElementById('PlayerName').value.trim();
    if (sName.length < 3) {
        alert("Please enter a player name");
        return;
    }
    g_objUserData.Name = g_objScore.Name = sName;

    if (g_objUserData.GameID != nGameID) {
        // Room changed: (re)subscribe to the new room.
        g_objUserData.GameID = nGameID;
        g_objGame.LeaderList = [];
        initWebSocket();
    } else {
        // Room unchanged (e.g. arrived via a share link): make sure we're subscribed.
        CheckConnection();
    }

    SetGameID(g_objUserData.GameID);

    // Load (or create) THIS room's sheet before sending anything to the server.
    // Previously SendScoreToServerDB() ran first, pushing the prior room's sheet
    // into the newly-joined room under our PlayerID.
    SetUserData();
    SetUpData();

    SendScoreToServerDB();
    setTimeout(function() {BCastRequestScores();}, 2000);

    ShowScoreMain();

    localStorage.setItem(g_objUserData.GameID, JSON.stringify(g_objScore));

}

// Navigate from the score sheet back to the main game lobby (one directory up).
const GoToLobby = () => {
    window.location.href = "../";
};

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
    sPage += "<div id='PlayerNameLabel' onclick='ShowEnterID()'>"+g_objScore.Name+"</div>";
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
    sPage += "<div id='DiceRack' class='DiceRack'>";
    sPage += "<div id='DiceTray' class='DiceTray'>";
    sPage += "<div class='ScoreDie' id='SD0' onclick='ToggleHold(0)'></div>";
    sPage += "<div class='ScoreDie' id='SD1' onclick='ToggleHold(1)'></div>";
    sPage += "<div class='ScoreDie' id='SD2' onclick='ToggleHold(2)'></div>";
    sPage += "<div class='ScoreDie' id='SD3' onclick='ToggleHold(3)'></div>";
    sPage += "<div class='ScoreDie' id='SD4' onclick='ToggleHold(4)'></div>";
    sPage += "<div id='RollBtn' class='RollBtn' onclick='RollDice()'><span id='RollsLeft'>3</span><span class='RollMoreTxt'>roll</span></div>";
    sPage += "</div>";
    sPage += "<div id='DiceHint' class='DiceHint'>Tap Roll to start your turn</div>";
    sPage += "</div>"; // end DiceRack

    sPage += "</div>"; // end Summary third

    sPage += "<div id='LobbyLink' class='LobbyLink' onclick='GoToLobby()' title='Back to the game lobby' aria-label='Back to lobby'>⬅️</div>";

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

/* ================= Computer Dice (3D) ================= */

const DiceGlyph = (n) => ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][n] || "";

// Category key -> index into g_objScore.Score
const CatIndex = (sClicked) => {
    let n = parseInt(sClicked);
    if (n >= 1 && n <= 6) return n - 1;
    return {C:6, TK:7, FK:8, FH:9, SS:10, LS:11, FD:12, B5:13}[sClicked];
};

const CatLabel = (sClicked) => {
    let n = parseInt(sClicked);
    if (n >= 1 && n <= 6) return n + "'s";
    return {C:"chance", TK:"3 of a kind", FK:"4 of a kind", FH:"full house",
            SS:"small straight", LS:"large straight", FD:"5 Dice", B5:"Bonus 5's"}[sClicked] || sClicked;
};

const InitDice = () => {
    g_objGame.Dice = {
        values: [1, 1, 1, 1, 1],
        held: [false, false, false, false, false],
        rollsLeft: 3,
        manualCats: {}
    };
};

// Are we in a "computer dice" turn (tray open and at least one roll made)?
const DiceScoringActive = () => {
    return g_objGame.DiceRackShowing && g_objGame.Dice && g_objGame.Dice.rollsLeft < 3;
};

const DiceTargets = () => [0,1,2,3,4].map(i => document.getElementById('SD'+i));

// Move the 3D dice off screen (used when the tray is closed or a turn resets).
const ParkDice = () => {
    if (window.dice3d)
        window.dice3d.snapToState([1,1,1,1,1], [false,false,false,false,false], [null,null,null,null,null]);
};

const ResetDiceTurn = () => {
    if (!g_objGame.Dice) InitDice();
    g_objGame.Dice.values = [1, 1, 1, 1, 1];
    g_objGame.Dice.held = [false, false, false, false, false];
    g_objGame.Dice.rollsLeft = 3;
    g_objGame.Dice.manualCats = {};
    ParkDice();
    UpdateDiceTray();
};

const FireConfetti = () => {
    if (!window.confetti) return;
    const cfg = { spread: 100, startVelocity: 50, scalar: 1.2 };
    window.confetti({ ...cfg, particleCount: 150, origin: { x: 0.2, y: 0.8 } });
    window.confetti({ ...cfg, particleCount: 150, origin: { x: 0.8, y: 0.8 } });
    setTimeout(() => window.confetti({ ...cfg, particleCount: 200, origin: { x: 0.5, y: 0.6 } }), 300);
};

// Called after every score/leaderboard update. When the local player's sheet is
// full: hide the dice tray (remembering to restore it on Clear). When every
// player in the room is finished, the top scorer gets confetti — once.
const HandleGameOverState = () => {
    if (TurnsRemaining(g_objScore) > 0) {
        g_objGame.Celebrated = false; // (re)started — allow a fresh celebration
        return;
    }

    // My game is over — hide the dice tray if it's open (park the 3D dice).
    if (g_objGame.DiceRackShowing) {
        g_objGame.DiceHiddenByGameOver = true;
        g_objGame.DiceRackShowing = false;
        let rack = document.getElementById('DiceRack');
        if (rack) rack.style.visibility = null;
        ParkDice();
    }

    // Confetti for the winner once EVERY player is out of turns.
    if (!g_objGame.Celebrated) {
        let list = g_objGame.LeaderList || [];
        if (list.length === 0) return;
        let allDone = list.every(p => TurnsRemaining(p) === 0);
        if (!allDone) return;
        let maxScore = Math.max.apply(null, list.map(p => Number(p.Score[17]) || 0));
        if ((Number(g_objScore.Score[17]) || 0) === maxScore) {
            g_objGame.Celebrated = true;
            FireConfetti();
        }
    }
};

// After Clear, bring the dice tray back if we hid it at game over.
const RestoreDiceAfterClear = () => {
    if (!g_objGame.DiceHiddenByGameOver) return;
    g_objGame.DiceHiddenByGameOver = false;
    g_objGame.DiceRackShowing = true;
    let rack = document.getElementById('DiceRack');
    if (rack) rack.style.visibility = 'visible';
    ResetDiceTurn();
    setSheetUnLocked();
};

const RollDice = () => {
    if (!g_objGame.Dice) InitDice();
    if (g_objGame.Dice.rollsLeft <= 0) return;

    // If we're viewing another player's sheet (tapped from the leaderboard), snap
    // back to our own sheet before rolling so the roll/scoring applies to us.
    if (g_objGame.ScoreSheetShowing !== g_objUserData.PlayerID) {
        DisplayScore(g_objScore);
    }

    setSheetUnLocked();               // scoring taps need the sheet unlocked
    g_objGame.Dice.manualCats = {};   // a fresh roll re-enables auto scoring

    let unheld = [];
    let finalValues = [];
    for (let i = 0; i < 5; i++) {
        if (g_objGame.Dice.held[i]) {
            finalValues.push(g_objGame.Dice.values[i]);
        } else {
            finalValues.push(1 + Math.floor(Math.random() * 6));
            unheld.push(i);
        }
    }
    g_objGame.Dice.values = finalValues;
    g_objGame.Dice.rollsLeft--;

    if (window.dice3d)
        window.dice3d.roll(finalValues, unheld, DiceTargets(), UpdateDiceTray);

    UpdateDiceTray();
};

const ToggleHold = (i) => {
    if (!g_objGame.Dice) return;
    if (3 == g_objGame.Dice.rollsLeft) return; // must roll at least once first
    g_objGame.Dice.held[i] = !g_objGame.Dice.held[i];
    if (window.dice3d)
        window.dice3d.snapToState(g_objGame.Dice.values, g_objGame.Dice.held, DiceTargets());
    UpdateDiceTray();
};

const UpdateDiceTray = () => {
    if (!g_objGame.Dice) return;
    for (let i = 0; i < 5; i++) {
        let el = document.getElementById('SD'+i);
        if (!el) continue;
        el.innerHTML = DiceGlyph(g_objGame.Dice.values[i]);
        el.classList.toggle('held', !!g_objGame.Dice.held[i]);
    }
    let rl = document.getElementById('RollsLeft');
    if (rl) rl.innerHTML = g_objGame.Dice.rollsLeft;

    let rb = document.getElementById('RollBtn');
    if (rb) {
        let bOut = g_objGame.Dice.rollsLeft <= 0;
        rb.style.opacity = bOut ? '0.35' : '1';
        rb.style.pointerEvents = bOut ? 'none' : 'auto';
    }
    let hint = document.getElementById('DiceHint');
    if (hint) {
        if (3 == g_objGame.Dice.rollsLeft)
            hint.innerHTML = "Tap Roll to start your turn";
        else if (g_objGame.Dice.rollsLeft > 0)
            hint.innerHTML = "Tap dice to hold · tap a category to score";
        else
            hint.innerHTML = "No rolls left · tap a category to score";
    }
};

// Compute what a category would score with the current dice.
const ComputeDiceScore = (sClicked, dice) => {
    let counts = {1:0, 2:0, 3:0, 4:0, 5:0, 6:0};
    let sum = 0;
    dice.forEach(d => { counts[d]++; sum += d; });
    let hasN = (n) => Object.values(counts).some(c => c >= n);
    let n = parseInt(sClicked);
    if (n >= 1 && n <= 6) return counts[n] * n;
    switch (sClicked) {
        case "C":  return sum;
        case "TK": return hasN(3) ? sum : 0;
        case "FK": return hasN(4) ? sum : 0;
        case "FH": return ((Object.values(counts).includes(3) && Object.values(counts).includes(2)) || hasN(5)) ? 25 : 0;
        case "SS":
            if (counts[1] && counts[2] && counts[3] && counts[4]) return 30;
            if (counts[2] && counts[3] && counts[4] && counts[5]) return 30;
            if (counts[3] && counts[4] && counts[5] && counts[6]) return 30;
            return 0;
        case "LS":
            if (counts[1] && counts[2] && counts[3] && counts[4] && counts[5]) return 40;
            if (counts[2] && counts[3] && counts[4] && counts[5] && counts[6]) return 40;
            return 0;
        case "FD": return hasN(5) ? 50 : 0;
    }
    return 0;
};

// Confirmation box shown when scoring a category from the computer dice.
// Three choices: Commit (take the computed score), Cancel (dismiss so you can
// try a different category), Manual (enter this category by hand instead).
const OfferDiceScore = (sClicked) => {
    let nScore = ComputeDiceScore(sClicked, g_objGame.Dice.values);
    let sDlg = "Score <b>" + nScore + "</b> in " + CatLabel(sClicked) + "?";
    sDlg += "<div class='DiceCommitBtns'>";
    sDlg += "<div class='DiceCommitBtn' onclick='CommitDiceScore(\""+sClicked+"\","+nScore+")'>Commit</div>";
    sDlg += "<div class='DiceCommitBtn DiceCommitCancel' onclick='CancelDiceScore()'>Cancel</div>";
    sDlg += "<div class='DiceCommitBtn DiceCommitManual' onclick='DeclineDiceScore(\""+sClicked+"\")'>Manual</div>";
    sDlg += "</div>";
    document.getElementById('DialogBox').innerHTML = "<div class='DialogBoxMsg DiceCommitMsg'>" + sDlg + "</div>";
};

// Cancel: just dismiss. The category is untouched and NOT flagged manual, so the
// user can tap another category and get its confirm dialog.
const CancelDiceScore = () => {
    document.getElementById('DialogBox').innerHTML = "";
};

// Manual: end the dice turn and reset the dice (ready to roll again). With the
// dice cleared, tapping the category now runs the normal manual tap-through, just
// as if the user had rolled physical dice.
const DeclineDiceScore = (sClicked) => {
    document.getElementById('DialogBox').innerHTML = "";
    ResetDiceTurn();
};

const CommitDiceScore = (sClicked, nScore) => {
    document.getElementById('DialogBox').innerHTML = "";
    let nIdx = CatIndex(sClicked);
    g_objScore.Score[nIdx] = nScore;

    // Recompute the upper-section bonus if an upper box changed.
    if (nIdx < 6) {
        let nUTotal = 0;
        for (let x = 0; x < 6; x++) nUTotal += g_objScore.Score[x];
        g_objScore.Score[14] = (nUTotal > 62) ? 35 : 0;
    }

    // Yahtzee bonus: five-of-a-kind after 5 Dice is already scored (50) adds 100
    // to Bonus 5's (unless the box being scored IS 5 Dice itself).
    if ("FD" != sClicked) {
        let d = g_objGame.Dice.values;
        let bAllSame = d.every(v => v === d[0]);
        if (bAllSame && 50 === g_objScore.Score[12]) {
            let cur = g_objScore.Score[13] || 0;
            g_objScore.Score[13] = Math.min(cur + 100, 900);
        }
    }

    LagSendLastMoveToast(nScore + " on " + CatLabel(sClicked));

    // Chosen behavior: clear the dice and wait for the next Roll.
    ResetDiceTurn();

    // Reuse EnterScore's tail (totals, broadcast, save) via the no-op "X" path.
    EnterScore("X");
};

const EnterScore = (sClicked) => {
    if (g_objGame.Locked)
        return;

    // Computer-dice scoring: if the dice tray is active and has been rolled this
    // turn, tapping an unscored category offers its computed score with a Commit
    // box instead of the manual tap-to-cycle. Declining (per category) or Bonus
    // 5's fall through to the normal manual behavior below.
    if (DiceScoringActive() && "X" != sClicked && "B5" != sClicked
            && !g_objGame.Dice.manualCats[sClicked]) {
        let nIdx = CatIndex(sClicked);
        if (null != nIdx && null == g_objScore.Score[nIdx]) {
            OfferDiceScore(sClicked);
            return;
        }
    }

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
    // Entering a score is proof we're here — refresh presence so an active player is
    // always the freshest entry and can never be aged out of the "who's here" list.
    if (window.firebaseBackend && window.firebaseBackend.touchPresence)
        window.firebaseBackend.touchPresence(g_objUserData.GameID, g_objUserData.PlayerID);
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
        // Firebase UpdateLeaderBoard will handle clearing the local UI
    }
}

const ClearAllRoomsInServerDB = () => {
    if ("Jeff" != g_objUserData.Name)
        return false;
    postFileFromServer("api", "ClearTable=" + true, clearAllRoomsCallback);
    function clearAllRoomsCallback(data) {
        // Firebase UpdateLeaderBoard will handle clearing the local UI
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
        lockWakeState();
    } else {
        document.getElementById("Turns").innerHTML = nTurns + " turns remaining";
        lockWakeState();
    }

    HandleGameOverState();
}

const LeaderList = (sData) => {
    //console.log(sData);
    // Defensive parse: a malformed/undefined payload used to throw here and, because
    // this runs inside a Firebase onValue/onChildAdded callback, took down the whole
    // handler (leaving the board half-updated). Bad input now just re-renders the
    // current list instead of crashing.
    let objData = null;
    try {
        if (sData !== undefined && sData !== null && sData !== "undefined")
            objData = JSON.parse(sData);
    } catch (e) {
        objData = null;
    }

    let sLeaderList = "";
    let bFound = false;
    let x=0;
    if (objData) for (x=0; x<g_objGame.LeaderList.length; x++) {
        if (g_objGame.LeaderList[x].PlayerID == objData.PlayerID) {
            if (g_objGame.LeaderList[x].dLastUpdate < objData.dLastUpdate)
                g_objGame.LeaderList[x] = objData;
            bFound = true;
        }
    }
    if (objData && !bFound) {
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

    // Note: "who's here" (WhosHere/NamesHere) is intentionally NOT computed here.
    // The scoreboard includes players who have left (so their scores remain
    // visible); live presence is tracked separately by UpdatePresenceUI().

    return sLeaderList;
}

// Render the live "who's here" count and name list from the presence feed
// (rooms/{room}/presence), which reflects who is actually connected right now.
const UpdatePresenceUI = () => {
    let list = Array.isArray(g_objGame.Presence) ? g_objGame.Presence : [];
    let nPlayers = list.length;
    let sPlayerLabel = (nPlayers === 1) ? "user" : "users";

    g_objGame.WhosHere = "<span onclick='CheckConnection()'>" + nPlayers + " " + sPlayerLabel + "</span>";
    if (document.getElementById('WhosHere')) {
        document.getElementById('WhosHere').innerHTML = g_objGame.WhosHere;
    }

    let names = [];
    for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].Name) names.push(list[i].Name);
    }
    g_objGame.NamesHere = names.join(", ");
    if (document.getElementById('NamesHere')) {
        document.getElementById('NamesHere').innerHTML = g_objGame.NamesHere;
    }
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
        // Bump the change timestamp so this clear wins newest-wins and syncs to
        // other tabs sharing our PlayerID instead of being ignored as "not newer".
        g_objScore.dLastUpdate = new Date().valueOf();
        g_objGame.LeaderList = [];
        DisplayScore(g_objScore);
        BCastScore(JSON.stringify(g_objScore));
        BCastNotification('Score', g_objScore.Name + ' cleared score sheet');
        BCastToast(g_objScore.Name + ' cleared sheet', g_objScore.Color);
        setSheetLocked();
        localStorage.setItem(g_objUserData.GameID, JSON.stringify(g_objScore));
        document.getElementById('ClearBtn').style.borderWidth = '0px';
        SendScoreToServerDB();
        RestoreDiceAfterClear();
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
        g_objScore.Score[6] = parseInt(document.getElementById('Sel').value) || 0;
        LagSendLastMoveToast(g_objScore.Score[6] + " on chance");
    }
    else if ("TK" == sCat) {
        g_objScore.Score[7] = parseInt(document.getElementById('Sel').value) || 0;
        LagSendLastMoveToast(g_objScore.Score[7] + " on 3 of a kind");
    }
    else if ("FK" == sCat) {
        g_objScore.Score[8] = parseInt(document.getElementById('Sel').value) || 0;
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
                        if (objData.ID != g_objGame.id) {
                            ColorToast(objData.Text, objData.Color);
                        }
                    }
                    else if ("UpdateScore" == objData.Event) {
                        if (document.getElementById("LeaderBoardEntries"))
                            document.getElementById("LeaderBoardEntries").innerHTML = LeaderList(objData.Player);
                        let objPlayer = JSON.parse(objData.Player);
                        if (objPlayer.PlayerID === g_objUserData.PlayerID) {
                            // Our own sheet, echoed from another tab sharing this UUID.
                            // Apply newest-wins: only accept it if it's strictly newer than
                            // what we hold, otherwise ignore it. Without this, a stale/blank
                            // echo (e.g. the other tab answering a score request before it
                            // has synced) would DisplayScore over our in-progress card and
                            // wipe it.
                            if ((objPlayer.dLastUpdate || 0) > (g_objScore.dLastUpdate || 0)) {
                                g_objScore = objPlayer;
                                g_objScore.dLastLoaded = new Date();
                                localStorage.setItem(g_objUserData.GameID, JSON.stringify(g_objScore));
                                if (g_objGame.ScoreSheetShowing == null ||
                                    g_objGame.ScoreSheetShowing == g_objUserData.PlayerID) {
                                    DisplayScore(g_objScore);
                                }
                            }
                        } else if (objPlayer.PlayerID == g_objGame.ScoreSheetShowing) {
                            // An opponent's sheet we're currently viewing — show the update.
                            DisplayScore(objPlayer);
                        }
                        // This may be the last player finishing, which triggers the
                        // winner's confetti.
                        HandleGameOverState();
                    }
                    else if ("RequestScore" == objData.Event) {
                        SendScore2ID(objData.ID, JSON.stringify(g_objScore));
                    }
                    else if ('RequestLeaderBoard' == objData.Event) {
                        SendLeaderBoard2ID(objData.ID, JSON.stringify(g_objGame.LeaderList));
                    }
                    else if ('UpdateLeaderBoard' == objData.Event) {
                        let objLeaderBoard = JSON.parse(objData.LeaderBoard);
                        // Is this the authoritative Firebase feed (a live snapshot of the
                        // room's scores node) or just a peer's in-memory reply to our
                        // BCastRequestLeaderBoard? Only the authoritative feed is allowed to
                        // ZERO our sheet; a peer whose LeaderList happens to be momentarily
                        // empty must never wipe us. The backend feed is always "BCast2Game";
                        // peer replies come back as "Msg2ID".
                        let isAuthoritativeFeed = (objData.Message === "BCast2Game");
                        g_objGame.LeaderList = [];
                        if (objLeaderBoard.length === 0) {
                            if (isAuthoritativeFeed) {
                                if (document.getElementById("LeaderBoardEntries"))
                                    document.getElementById("LeaderBoardEntries").innerHTML = "";
                                // WhosHere/NamesHere are driven by the presence feed.
                                g_objScore.Score = [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null];
                                localStorage.setItem(g_objUserData.GameID, JSON.stringify(g_objScore));
                                DisplayScore(g_objScore);
                            }
                            // Empty peer reply: ignore entirely.
                        } else {
                            let adoptedOwn = false;
                            for (let x=0; x<objLeaderBoard.length; x++) {
                                // Entries arrive in two shapes: the authoritative feed wraps
                                // each sheet as {player_id, score:"<json>"}, while a peer reply
                                // (SendLeaderBoard2ID) sends the parsed sheet objects directly.
                                // Normalize both to a sheet JSON string.
                                let entry = objLeaderBoard[x];
                                let jsonPlayer = (entry && entry.score !== undefined)
                                    ? entry.score
                                    : (entry ? JSON.stringify(entry) : null);
                                if (!jsonPlayer) continue;

                                if (document.getElementById("LeaderBoardEntries"))
                                    document.getElementById("LeaderBoardEntries").innerHTML = LeaderList(jsonPlayer);

                                // Perfect-sync for tabs sharing our PlayerID (same UUID):
                                // if this entry is OUR sheet and is newer than what we hold
                                // locally, adopt it so an edit made in the other tab shows up
                                // here live instead of the two tabs racing and clobbering.
                                try {
                                    let incoming = JSON.parse(jsonPlayer);
                                    if (incoming && incoming.PlayerID === g_objUserData.PlayerID &&
                                        (incoming.dLastUpdate || 0) > (g_objScore.dLastUpdate || 0)) {
                                        g_objScore = incoming;
                                        g_objScore.dLastLoaded = new Date();
                                        localStorage.setItem(g_objUserData.GameID, JSON.stringify(g_objScore));
                                        adoptedOwn = true;
                                    }
                                } catch (e) {}
                            }
                            // Redraw the main card only when we're viewing our own sheet, so
                            // syncing doesn't yank us off an opponent's sheet we're inspecting.
                            if (adoptedOwn &&
                                (g_objGame.ScoreSheetShowing == null ||
                                 g_objGame.ScoreSheetShowing == g_objUserData.PlayerID)) {
                                DisplayScore(g_objScore);
                            }
                        }
                    }
                    else if ('UpdatePresence' == objData.Event) {
                        g_objGame.Presence = JSON.parse(objData.Presence);
                        UpdatePresenceUI();
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
    }, {
        // Self-presence: registered in the room's presence node with automatic
        // removal on disconnect, so "who's here" reflects live connections.
        id: g_objGame.id,
        PlayerID: g_objUserData.PlayerID,
        Name: g_objScore.Name ? g_objScore.Name : "Score",
        Color: g_objUserData.Color
    });

    startPresenceHeartbeat();
}

// Keep our presence node fresh so peers don't age us out. The backend prunes any
// presence not seen within its stale window; this interval re-asserts ours well
// inside that window while we're connected and the tab is visible.
const PRESENCE_HEARTBEAT_MS = 30000;
const startPresenceHeartbeat = () => {
    stopPresenceHeartbeat();
    g_objGame.presenceHeartbeat = setInterval(() => {
        if (document.visibilityState === 'hidden') return;
        if (window.firebaseBackend && window.firebaseBackend.touchPresence)
            window.firebaseBackend.touchPresence(g_objUserData.GameID, g_objUserData.PlayerID);
    }, PRESENCE_HEARTBEAT_MS);
};
const stopPresenceHeartbeat = () => {
    if (g_objGame.presenceHeartbeat) {
        clearInterval(g_objGame.presenceHeartbeat);
        g_objGame.presenceHeartbeat = null;
    }
};

let stopWebSocket = () => {
    if (!window.firebaseBackend) return;
    stopPresenceHeartbeat();
    // Tell peers we're leaving (best-effort) and remove our live presence node.
    try {
        let objData = {
            Message: "PlayerExitingGame",
            Type: "Score",
            GameID: parseInt(g_objUserData.GameID),
            ID: g_objGame.id,
            Name: g_objScore.Name ? g_objScore.Name : "Score"
        };
        sendMessage(JSON.stringify(objData));
    } catch (e) {}
    if (window.firebaseBackend.leavePresence)
        window.firebaseBackend.leavePresence(g_objUserData.GameID, g_objUserData.PlayerID);
    if (window.firebaseBackend.currentUnsubscribe) {
        window.firebaseBackend.currentUnsubscribe();
        window.firebaseBackend.currentUnsubscribe = null;
    }
    window.firebaseBackend.isConnected = false;
}
let close_socket = () => stopWebSocket();

// Remove presence promptly on a graceful close. onDisconnect() still covers
// crashes / network drops server-side.
window.addEventListener('pagehide', () => {
    if (window.firebaseBackend && window.firebaseBackend.leavePresence)
        window.firebaseBackend.leavePresence(g_objUserData.GameID, g_objUserData.PlayerID);
});
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
        // Refresh presence right away so returning to a backgrounded tab doesn't
        // wait up to a full heartbeat interval to re-announce us.
        if (window.firebaseBackend && window.firebaseBackend.touchPresence)
            window.firebaseBackend.touchPresence(g_objUserData.GameID, g_objUserData.PlayerID);
        startPresenceHeartbeat();
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
	// Inclusive of both min and max (callers pass length-1 expecting the last index to be reachable).
	var range = max - min + 1;
	var bits_needed = Math.ceil(Math.log2(range));
	if (bits_needed > 53) {
		throw new Error("We cannot generate numbers larger than 53 bits.");
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

// Capture the install prompt so it can be shown later from a user gesture.
// Calling event.prompt() automatically (as before) throws NotAllowedError because
// browsers require the install prompt to be triggered by a real user interaction.
// We stash the event and expose InstallApp() to wire to an install button/gesture.
let g_deferredInstallPrompt = null;
if ('serviceWorker' in navigator && 'BeforeInstallPromptEvent' in window) {
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        g_deferredInstallPrompt = event;
    });
}
const InstallApp = () => {
    // Must be called from within a user gesture (e.g. a click handler).
    if (!g_deferredInstallPrompt) return;
    g_deferredInstallPrompt.prompt();
    g_deferredInstallPrompt = null;
};


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
    sPage += "<li class='context-link' id='Share'>";
    sPage += "<span class='context-label'>Share</span>";
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
    sPage += "<li class='context-link' id='ClearRoom'>";
    sPage += "<span class='context-label'>Clear Room</span>";
    sPage += "</li>";
    sPage += "<li class='context-link' id='GetRoomList'>";
    sPage += "<span class='context-label'>Get Room List</span>";
    sPage += "</li>";

    sPage += "</ul>";
    return sPage;
}

// --- SHARE FEATURE HANDLERS ---
const getShareUrl = () => {
    const baseUrl = window.location.origin + window.location.pathname;
    return `${baseUrl}?room=${g_objUserData.GameID}`;
};

const getShareText = () => {
    return `Join my 5 Dice game room #${g_objUserData.GameID}!`;
};

window.ShowShareModal = () => {
    const roomIdEl = document.getElementById('share-room-id');
    const urlInputEl = document.getElementById('share-url-input');
    const modalEl = document.getElementById('share-modal');

    if (roomIdEl) roomIdEl.innerText = g_objUserData.GameID || '';
    if (urlInputEl) urlInputEl.value = getShareUrl();
    if (modalEl) {
        modalEl.classList.remove('hidden');
        modalEl.style.display = 'flex';
    }
};

window.hideShareModal = () => {
    const modalEl = document.getElementById('share-modal');
    if (modalEl) {
        modalEl.classList.add('hidden');
        modalEl.style.display = 'none';
    }
};

window.copyShareUrl = () => {
    const url = getShareUrl();
    navigator.clipboard.writeText(url).then(() => {
        if (typeof ColorToast === 'function') {
            ColorToast('Room link copied to clipboard!', '#28a745');
        } else {
            alert('Room link copied to clipboard!');
        }
    }).catch(() => {
        const input = document.getElementById('share-url-input');
        if (input) {
            input.select();
            input.setSelectionRange(0, 99999);
            document.execCommand('copy');
            alert('Room link copied to clipboard!');
        }
    });
};

window.triggerNativeShare = () => {
    const shareData = {
        title: '5 Dice Score Sheet',
        text: getShareText(),
        url: getShareUrl()
    };
    if (navigator.share) {
        navigator.share(shareData).catch(err => console.log('Share cancelled:', err));
    } else {
        copyShareUrl();
    }
};

window.shareToSignal = () => {
    const shareData = {
        title: '5 Dice Score Sheet',
        text: getShareText(),
        url: getShareUrl()
    };
    if (navigator.share) {
        navigator.share(shareData).catch(err => console.log('Signal share cancelled:', err));
    } else {
        copyShareUrl();
        alert('Link copied! Open Signal and paste into any chat.');
    }
};

window.shareToWhatsApp = () => {
    const text = encodeURIComponent(`${getShareText()} ${getShareUrl()}`);
    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
};

window.shareToSMS = () => {
    const text = encodeURIComponent(`${getShareText()} ${getShareUrl()}`);
    window.open(`sms:?body=${text}`, '_self');
};

window.shareToEmail = () => {
    const subject = encodeURIComponent(`Join 5 Dice Game - Room #${g_objUserData.GameID}`);
    const body = encodeURIComponent(`${getShareText()}\n\nClick here to join:\n${getShareUrl()}`);
    window.open(`mailto:?subject=${subject}&body=${body}`, '_self');
};

// --- ROOM LIST MODAL HANDLERS ---
// Human-readable "time since last activity" from a lastEntered timestamp (ms).
const formatTimeAgo = (ts) => {
    if (!ts || typeof ts !== 'number') return 'unknown';
    let diff = Date.now() - ts;
    if (diff < 0) diff = 0;
    const min = 60000, hr = 3600000, day = 86400000;
    if (diff < min) return 'just now';
    if (diff < hr) { const n = Math.floor(diff / min); return n + 'm ago'; }
    if (diff < day) { const n = Math.floor(diff / hr); return n + 'h ago'; }
    const n = Math.floor(diff / day);
    return n + 'd ago';
};

window.ShowRoomListModal = async () => {
    const modalEl = document.getElementById('room-list-modal');
    const containerEl = document.getElementById('room-list-container');
    if (!modalEl || !containerEl) return;

    containerEl.innerHTML = `<p style="color: #aaaaaa; text-align: center;">Loading active rooms...</p>`;
    modalEl.classList.remove('hidden');
    modalEl.style.display = 'flex';

    try {
        let rooms = [];
        if (window.firebaseBackend && typeof window.firebaseBackend.getAllRooms === 'function') {
            rooms = await window.firebaseBackend.getAllRooms();
        }

        if (!rooms || rooms.length === 0) {
            containerEl.innerHTML = `
                <div style="text-align: center; padding: 15px 0;">
                    <p style="color: #dddddd; margin-bottom: 12px;">No active game rooms found.</p>
                    <button style="background: #00ffcc; color: #0f0f1b; border: none; padding: 6px 14px; border-radius: 8px; font-weight: bold; cursor: pointer;" onclick="hideRoomListModal(); ShowEnterID();">Set Up New Room</button>
                </div>
            `;
            return;
        }

        // Sort rooms by lastEntered descending or numerically
        rooms.sort((a, b) => (b.lastEntered || 0) - (a.lastEntered || 0));

        let html = '';
        rooms.forEach(r => {
            const playerStr = (r.players && r.players.length > 0) ? r.players.join(', ') : 'Waiting...';
            const lastPlayed = formatTimeAgo(r.lastEntered);
            html += `
                <div class="room-list-item" onclick="joinRoomFromList('${r.id}')">
                    <span class="room-link">Room #${r.id}</span>
                    <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px;">
                        <span class="room-players">👥 ${playerStr}</span>
                        <span class="room-lastplayed" style="color: #7a7f9a; font-size: 0.72rem;">🕐 ${lastPlayed}</span>
                    </div>
                </div>
            `;
        });
        containerEl.innerHTML = html;
    } catch (err) {
        console.error("Error fetching rooms:", err);
        containerEl.innerHTML = `<p style="color: #ff5555; text-align: center;">Failed to load rooms.</p>`;
    }
};

window.hideRoomListModal = () => {
    const modalEl = document.getElementById('room-list-modal');
    if (modalEl) {
        modalEl.classList.add('hidden');
        modalEl.style.display = 'none';
    }
};

window.joinRoomFromList = (roomId) => {
    hideRoomListModal();
    g_objUserData.GameID = roomId;
    ShowEnterID();
};

const InitializeContextMenu = (sWindowShowing) => {
    contextMenu = document.querySelector(".context");
    if (!contextMenu) return;
    contextMenu.style.textAlign = 'left';

    const shareBtn = document.querySelector("#Share");
    if (shareBtn) {
        shareBtn.addEventListener("click", (ev) => {
            if (ev) ev.stopPropagation();
            if (contextMenu) contextMenu.style.visibility = null;
            ShowShareModal();
        });
    }

    const toggleDiceBtn = document.querySelector("#ToggleDice");
    if (toggleDiceBtn) {
        toggleDiceBtn.addEventListener("click", () => {
            g_objGame.DiceRackShowing = !g_objGame.DiceRackShowing;
            const rack = document.getElementById('DiceRack');
            if (rack)
                rack.style.visibility = g_objGame.DiceRackShowing ? 'visible' : null;
            if (g_objGame.DiceRackShowing) {
                ResetDiceTurn();     // fresh turn: 3 rolls, nothing held
                setSheetUnLocked();  // allow tapping categories to score
            } else {
                ParkDice();          // hide the 3D dice when the tray is closed
            }
        });
    }

    const refreshLeaderBtn = document.querySelector("#RefreshLeaderBoard");
    if (refreshLeaderBtn) {
        refreshLeaderBtn.addEventListener("click", () => {
            RequestLeaderBoard();
            BCastRequestLeaderBoard();
        });
    }

    const gameIdBtn = document.querySelector("#GameID");
    if (gameIdBtn) {
        gameIdBtn.addEventListener("click", () => {
            ShowEnterID();
        });
    }

    const aboutBtn = document.querySelector("#About");
    if (aboutBtn) {
        aboutBtn.addEventListener("click", () => {
            alert("Score Sheet rev. v240225k");
        });
    }

    const clearRoomBtn = document.querySelector("#ClearRoom");
    if (clearRoomBtn) {
        clearRoomBtn.addEventListener("click", () => {
            if (confirm("Clear the room?"))
                ClearRoomInServerDB();
        });
    }

    const getRoomListBtn = document.querySelector("#GetRoomList");
    if (getRoomListBtn) {
        getRoomListBtn.addEventListener("click", (ev) => {
            if (ev) ev.stopPropagation();
            if (contextMenu) contextMenu.style.visibility = null;
            ShowRoomListModal();
        });
    }

    // Register the document-level handlers only once. InitializeContextMenu runs on
    // every ShowScoreMain() render; without this guard the listeners stack up and leak.
    if (!window._contextMenuDocHandlersAdded) {
        window._contextMenuDocHandlersAdded = true;

        document.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            updateMenuPositon(ev.clientX, ev.clientY);
            if (contextMenu) contextMenu.style.visibility = "visible";
        });

        document.addEventListener("click", () => {
            if (contextMenu) contextMenu.style.visibility = null;
        });
    }
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
  // A wake lock can only be acquired while the page is visible; requesting one on a
  // hidden/backgrounded tab throws "The requesting page is not visible". Skip it —
  // the visibilitychange handler re-locks when the tab comes back to the foreground.
  if (document.visibilityState !== 'visible') return;
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
    // Feature-detect: iOS Safari (outside an installed PWA) has no Notification API,
    // and referencing it throws a ReferenceError that would abort the rest of onload
    // (including the initial SendScoreToServerDB()).
    if (typeof Notification === 'undefined' || !Notification.requestPermission)
        return;
    try {
        const p = Notification.requestPermission();
        if (p && typeof p.then === 'function') p.then((result) => {}).catch(() => {});
    } catch (e) { /* older callback-style / unsupported */ }
}

const showNotification = (title, text, bOnlyIfHidden) => {
    if (bOnlyIfHidden && 'visible' === document.visibilityState)
        return;

    // Guard: no Notification API (e.g. iOS Safari tab) — bail instead of throwing
    // inside the incoming-message handler.
    if (typeof Notification === 'undefined')
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
    try {
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
            doneCallback("[]");
        } else if (sData.startsWith("ClearTable=")) {
            await window.firebaseBackend.clearTable();
            doneCallback("[]");
        }
    } catch (error) {
        console.error("Firebase Error:", error);
        if (error.code && error.code.includes('permission-denied')) {
            ColorToast("Firebase Permission Denied! App Check is blocking access (e.g. running on file:// or localhost).", "red");
        } else {
            ColorToast("Firebase Error: " + error.message, "red");
        }
    }
}

//let diceUnicode = ['\u2680', '\u2681', '\u2682', '\u2683', '\u2684', '\u2685'];

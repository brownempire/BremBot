import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const playerSource = read("ios/App/BremLogicWatchShared/BremLogicLaunchSoundPlayer.swift");
const sceneSource = read("ios/App/App/SceneDelegate.swift");
const watchSource = read("ios/App/BremLogicWatchApp/BremLogicWatchContentView.swift");
const projectSource = read("ios/App/BremLogic.xcodeproj/project.pbxproj");
const dashboardSource = read("app/signals-bot/page.tsx");

test("iPhone launch sound runs once per native process and not on foreground resumes", () => {
  assert.match(playerSource, /firstForegroundActivationHandled = false/);
  assert.match(playerSource, /guard isActive, !firstForegroundActivationHandled else \{ return \}/);
  assert.match(playerSource, /firstForegroundActivationHandled = true/);
  assert.match(playerSource, /playLaunchSound\(remainingAttempts: 2\)/);
  assert.match(playerSource, /guard isForegroundActive, remainingAttempts > 0 else \{ return \}/);
  assert.match(sceneSource, /sceneDidBecomeActive[\s\S]*handleForegroundState\(isActive: true\)/);
  assert.match(sceneSource, /sceneWillResignActive[\s\S]*handleForegroundState\(isActive: false\)/);
});

test("native launch playback retries during startup and retains the player", () => {
  assert.match(playerSource, /private var audioPlayer: AVAudioPlayer\?/);
  assert.match(playerSource, /Bundle\.main\.url\(forResource: "brem_open", withExtension: "wav"\)/);
  assert.match(playerSource, /player\.prepareToPlay\(\)/);
  assert.match(playerSource, /audioPlayer = player/);
  assert.match(playerSource, /if !player\.play\(\)/);
  assert.match(playerSource, /asyncAfter\(deadline: \.now\(\) \+ 0\.35\)/);
});

test("watch app sounds on every background-to-foreground activation", () => {
  assert.match(playerSource, /func handleEveryForegroundActivation\(isActive: Bool\)/);
  assert.match(playerSource, /let becameActive = isActive && !isForegroundActive/);
  assert.match(playerSource, /guard becameActive else \{ return \}[\s\S]*playLaunchSound\(remainingAttempts: 2\)/);
  assert.match(watchSource, /\.task \{[\s\S]*handleEveryForegroundActivation\(isActive: true\)/);
  assert.match(
    watchSource,
    /\.onChange\(of: scenePhase\)[\s\S]*phase == \.active[\s\S]*handleEveryForegroundActivation\(isActive: true\)[\s\S]*phase == \.background[\s\S]*handleEveryForegroundActivation\(isActive: false\)/,
  );
  assert.doesNotMatch(
    watchSource,
    /phase == \.inactive[\s\S]*handleEveryForegroundActivation\(isActive: false\)/,
  );
  assert.match(projectSource, /BremLogicLaunchSoundPlayer\.swift in iPhone Sources/);
  assert.match(projectSource, /BremLogicLaunchSoundPlayer\.swift in Watch App Sources/);
  assert.match(projectSource, /brem_open\.wav in Watch Resources/);
  assert.equal(fs.existsSync(path.join(process.cwd(), "ios/App/App/brem_open.wav")), true);
});

test("WebView startup cannot double-play the native opening sound", () => {
  assert.doesNotMatch(dashboardSource, /APP_OPEN_SOUND_SESSION_KEY/);
  assert.doesNotMatch(dashboardSource, /NATIVE_NOTIFICATION_SOUNDS\.appOpen/);
  for (const sound of ["brem_signal.wav", "brem_approval.wav", "brem_tp.wav", "brem_sl.wav"]) {
    assert.match(dashboardSource, new RegExp(sound.replace(".", "\\.")));
    assert.match(projectSource, new RegExp(sound.replace(".", "\\.")));
  }
});

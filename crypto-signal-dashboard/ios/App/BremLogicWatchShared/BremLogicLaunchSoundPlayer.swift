import AVFoundation
import Foundation

@MainActor
final class BremLogicLaunchSoundPlayer: NSObject, AVAudioPlayerDelegate {
    static let shared = BremLogicLaunchSoundPlayer()

    private var audioPlayer: AVAudioPlayer?
    private var firstForegroundActivationHandled = false
    private var isForegroundActive = false

    func handleForegroundState(isActive: Bool) {
        isForegroundActive = isActive
        guard isActive, !firstForegroundActivationHandled else { return }

        firstForegroundActivationHandled = true
        playLaunchSound(remainingAttempts: 2)
    }

    private func playLaunchSound(remainingAttempts: Int) {
        guard isForegroundActive, remainingAttempts > 0 else { return }
        guard let soundURL = Bundle.main.url(forResource: "brem_open", withExtension: "wav") else {
            return
        }

        do {
            try AVAudioSession.sharedInstance().setCategory(.ambient, mode: .default, options: [.mixWithOthers])
            try AVAudioSession.sharedInstance().setActive(true)

            let player = try AVAudioPlayer(contentsOf: soundURL)
            player.delegate = self
            player.volume = 1
            player.prepareToPlay()
            audioPlayer = player

            if !player.play() {
                scheduleRetry(remainingAttempts: remainingAttempts - 1)
            }
        } catch {
            scheduleRetry(remainingAttempts: remainingAttempts - 1)
        }
    }

    private func scheduleRetry(remainingAttempts: Int) {
        guard remainingAttempts > 0 else { return }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            self?.playLaunchSound(remainingAttempts: remainingAttempts)
        }
    }
}

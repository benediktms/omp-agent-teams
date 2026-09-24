import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const PROFILE_READY_EVENT = "teams:profile-ready";
const SKILLS_LOADED_EVENT = "teams:skills-loaded";

export default function (pi: ExtensionAPI): void {
	let sessionStarted = false;
	let skillsLoaded = false;
	let notified = false;
	const notifyWhenReady = () => {
		if (!sessionStarted || !skillsLoaded || notified) return;
		notified = true;
		pi.events.emit(PROFILE_READY_EVENT, undefined);
	};
	pi.events.on(SKILLS_LOADED_EVENT, () => {
		skillsLoaded = true;
		notifyWhenReady();
	});
	pi.on("session_start", () => {
		sessionStarted = true;
		notifyWhenReady();
	});
}

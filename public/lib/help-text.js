// Help text: the small grey lines under titles and switches. Hidden unless Settings › Show help text is on
// (settings.showHelp, saved). index.html starts with the class on, so nothing flashes before settings load.
export const HIDE_CLASS = 'hide-descriptions';
export const hidesHelp = (settings) => settings?.showHelp !== true;
export const applyHelpText = (settings, body = document.body) => body.classList.toggle(HIDE_CLASS, hidesHelp(settings));

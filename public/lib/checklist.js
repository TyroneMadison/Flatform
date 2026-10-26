// The Flatform Test app's v3 checklist: one line per thing to try, each marked pass or fail on the Test screen and
// kept in the test app's data folder (test-checklist.json). `open`: where to start, filled in by the page.
import { PLATES } from './pipeline.js';

export const CHECKLIST = [
  { group: 'Auto-rig and model kind', items: [
    { id: 'rig-posed', text: 'Sample humanoid (rigged): Compose shows Model type Humanoid and the A-pose. Pick Hero stance or Kneel: the body moves.', open: 'humanoid-rigged' },
    { id: 'rig-error', text: 'Sample humanoid (no skeleton): Pose and motion shows a clear "No skeleton" message instead of poses that do nothing.', open: 'humanoid' },
    { id: 'rig-run', text: 'On that model click Auto-rig: a new version (2) appears after a moment and the pose chips now move it.', open: 'humanoid' },
    { id: 'rig-car', text: 'Sample car: Model type Car; no humanoid poses and no Auto-rig anywhere; car stances (Lowered, Wheels turned) work.', open: 'car' },
    { id: 'rig-switch', text: 'Switch the sample car to Humanoid and back to Car; leave and reopen Compose: the choice is kept.', open: 'car' },
    { id: 'rig-new-kind', text: 'Switch to the Warframe workspace and make a model from sample photo person.png: it is a Humanoid. Back in Car, car.png gives a Car.' },
    { id: 'rig-render', text: 'Render the posed humanoid with Blender: frames are written (mock Blender). With the real Blender set in Settings, the pose shows in the frames.', open: 'humanoid-rigged' },
  ] },
  { group: 'Rooms', items: [
    { id: 'room-default', text: 'A new model opens in White Cyc Studio (pinned Default in the scene list).' },
    ...Object.entries(PLATES).map(([slug, p]) => ({ id: `room-${slug}`, text: `${p.label}: a 3D room, not a photo. In Free roam, orbit: floor and background have depth and turn with the camera.`, open: `room-${slug}` })),
    { id: 'room-scale', text: 'Humanoid in Luxury Garage: the room is at a person\'s scale (doors and lamps look right round them), not a car\'s.', open: 'room-scale' },
    { id: 'room-sun', text: 'Desert Highway Dusk: the car\'s shadow falls away from the sun you see in the sky. Moving the key light on Render turns the sky with it.', open: 'room-desert-highway-dusk' },
    { id: 'room-blender', text: 'Render a room scene with Blender: the frames show that room (mock Blender uses its thumbnail; the real Blender renders it).', open: 'room-night-city-rain' },
  ] },
  { group: 'Test app', items: [
    { id: 'app-separate', text: 'The title bar says Flatform Test, and the data folder below is "Flatform Test", not your Flatform library.' },
    { id: 'app-mock', text: 'Generate from a sample photo: it finishes in seconds and the Tripo balance stays 9999 (mock, no credits spent).' },
    { id: 'app-updates', text: 'No update banner, and Settings shows update checks off.' },
  ] },
];
export const CHECK_IDS = CHECKLIST.flatMap((g) => g.items.map((i) => i.id));

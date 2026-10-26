// The Flatform Test app's v3 checklist: one line per thing to try, each marked pass or fail on the Test screen and
// kept in the test app's data folder (test-checklist.json). `open`: where to start, filled in by the page.
import { ENVIRONMENTS } from './pipeline.js';

export const CHECKLIST = [
  { group: 'Auto-rig and model kind', items: [
    { id: 'rig-posed', text: 'Sample humanoid (rigged): Compose shows Model type Humanoid and the A-pose. Pick Hero stance or Kneel: the body moves.', open: 'humanoid-rigged' },
    { id: 'rig-error', text: 'Sample humanoid (no skeleton): Pose and motion shows a clear "No skeleton" message instead of poses that do nothing.', open: 'humanoid' },
    { id: 'rig-run', text: 'On that model click Auto-rig: a new version (2) appears after a moment and the pose chips now move it.', open: 'humanoid' },
    { id: 'rig-car', text: 'Sample car: Model type Car; no humanoid poses and no Auto-rig anywhere; car stances (Lowered, Wheels turned) work.', open: 'car' },
    { id: 'rig-switch', text: 'Switch the sample car to Humanoid and back to Car; leave and reopen Compose: the choice is kept.', open: 'car' },
    { id: 'rig-new-kind', text: 'Switch to the Warframe workspace and make a model from sample photo person.png: it is a Humanoid. Back in Car, car.png gives a Car.' },
    { id: 'rig-no-blender', text: 'Settings: clear the Blender path (the mock). On the humanoid with no skeleton, Pose and motion says plainly that Blender is not installed and Auto-rig is greyed out. Locate test-app/mock-blender.mjs again afterwards.', open: 'humanoid' },
    { id: 'blender-found', text: 'Settings, Rendering: click Find it for me. Blender shows its folder and says Flatform found it by itself (on this PC the portable Blender 5.2.2 in your home folder). "Not installed" only shows when there is truly no Blender. Locate test-app/mock-blender.mjs again afterwards.' },
    { id: 'rig-render', text: 'Render the posed humanoid with Blender: frames are written (mock Blender). With the real Blender set in Settings, the pose shows in the frames.', open: 'humanoid-rigged' },
  ] },
  { group: 'Rooms', items: [
    { id: 'room-default', text: 'A new model opens in White Cyc Studio (pinned Default in the scene list).' },
    ...Object.entries(ENVIRONMENTS).map(([slug, p]) => ({ id: `room-${slug}`, text: `${p.label}: a 3D room, not a photo. In Free roam, orbit: floor and background have depth and turn with the camera.`, open: `room-${slug}` })),
    { id: 'room-scale', text: 'Humanoid in Luxury Garage: the room is at a person\'s scale (doors and lamps look right round them), not a car\'s.', open: 'room-scale' },
    { id: 'room-sun', text: 'Desert Highway Dusk: the sun sits low behind the car and the car\'s shadow falls towards you, away from it.', open: 'room-desert-highway-dusk' },
    { id: 'room-models', text: 'Coast has benches and a lifebuoy on the sea wall, Night City street lamps and bins, Villa planters and a terrace table, Desert boulders, quiver trees and scrub: real models, not boxes.', open: 'room-golden-hour-coast' },
    { id: 'room-skies', text: 'Golden Hour Coast shows a real sunrise sky over the sea; Night City Rain a real night city sky above the towers.', open: 'room-night-city-rain' },
    { id: 'room-rain', text: 'Night City Rain: rain falls in Compose, and keeps falling while you orbit in Free roam.', open: 'room-night-city-rain' },
    { id: 'room-thumbs', text: 'Scene list: every place, Soft studio and Showroom included, has a picture of the place as its thumbnail.' },
    { id: 'room-blender', text: 'Render a room scene with Blender: the frames show that room (mock Blender uses its thumbnail; the real Blender renders it).', open: 'room-night-city-rain' },
  ] },
  { group: 'Add things shelf', items: [
    { id: 'shelf-open', text: 'Compose on the sample car: press A (or click Add things). The left panel lists your people and cars from the Library and the props (benches, lamps, bins, trees). Press A again for Places.', open: 'car' },
    { id: 'shelf-search', text: 'Type "lamp" in Search: only the street lamp is left. Clear it and pick People: only the humanoids.', open: 'car' },
    { id: 'shelf-drag', text: 'Drag the street lamp onto the floor in the 3D view: the view gets a dashed outline while you drag, and the lamp stands where you let go.', open: 'car' },
    { id: 'shelf-click', text: 'Click a person on the shelf: they stand next to the car at a person height (1.8 m). In your scene lists both; Take out removes one, Ctrl+Z brings it back.', open: 'car' },
    { id: 'shelf-render', text: 'Render the car with Blender: the lamp and the person are in the frames too (mock Blender shows the room thumbnail; the real Blender renders them).', open: 'car' },
  ] },
  { group: 'Test app', items: [
    { id: 'app-separate', text: 'The title bar says Flatform Test, and the data folder below is "Flatform Test", not your Flatform library.' },
    { id: 'app-mock', text: 'Generate from a sample photo: it finishes in seconds and the Tripo balance stays 9999 (mock, no credits spent).' },
    { id: 'app-updates', text: 'No update banner, and Settings shows update checks off.' },
  ] },
];
export const CHECK_IDS = CHECKLIST.flatMap((g) => g.items.map((i) => i.id));

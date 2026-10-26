# Changelog

Newest first. Numbering: [VERSIONING.md](VERSIONING.md).

## Unreleased

- **A picture of every room.** The World picker shows each place as a picture card with its name under it,
  rendered from the real 3D room at its own camera (320 x 200 WebP in `public/img/rooms/`). Hover a card to read
  what the place is like. Night City's picture uses its softer glow, so the model is not washed out.
- **Auto-rig that holds together.** Add joints now finds the arms, legs, head and joints from the model's own shape
  (which way it faces, slices through the body, paths along each limb), so armoured Tripo models no longer tear or
  smear when posed. Separate armour pieces move whole with the limb they sit on; bigger pieces bend only with their
  own limb. If the limbs can't be found, Flatform says so plainly and lets you click the chin, groin, elbows, wrists,
  knees and ankles instead.
- **Rigging runs on its own.** The model on screen stays as it is until the version with joints is ready and checked,
  then swaps in. Renders started meanwhile wait in the queue ("Rigging…" in the title bar).
- **Undo covers poses and joints.** Ctrl+Z, the Undo buttons and the Undo on every note share one history that now
  includes the model version: undo takes back hand-posed bones, moments, adding joints and Reset scene.
- **Reset scene goes back to the model before joints.** The versions with joints stay under Versions.
- **Test rig fix.** On slow computers the Test rig could open to a black view; it now always starts on its feet.

## 1.1 (1.1.0)

The first 1.x release. Flatform drops the 0.x numbers: from here releases go 1.1, 1.2 … 1.9, 2.0.

- **Pose by hand.** Rigged people in Compose get grab dots on hands, feet and hips and turn rings on head, neck and
  back. Mirror left and right, keep feet on the floor, start over, or save the pose to use again.
- **Test rig.** Walk, run, jump, slide, wall run and climb with a rigged person in a small practice arena, straight
  from Compose. Your scene is never touched; Esc takes you back.
- **Render inside Compose.** The separate Render screen is gone. Stills, turntables, model files, looks and quality
  all live under the scene. Renders line up in a queue tray, a light in the title bar shows progress and time left,
  and a note with Open and Show in folder appears when one finishes. White Cyc Studio is the new default scene.
- **Auto-save and Recents.** Compose saves your scene every few minutes and when you leave. If Flatform closes
  unexpectedly it offers to bring your last session back. Your last three scenes sit on the home screen and in
  Ctrl+K. Reset scene puts the look back to how it started, and can be undone.
- **Keyboard shortcuts.** One list for every key. Press ? for a cheat sheet, and Ctrl+K lists every shortcut.
  Keys never fire while you type, and Settings won't let two actions share one key.
- **The Stage.** The 3D view fills the window. Four steps run along the bottom (Photo, 3D model, Scene and render,
  Finish) and a dock on the left holds the tools for the step you are on. Render ideas suggest a shot in one click.
- **Real rooms.** Every scene is a real 3D room that turns with the camera, at real size: studios, a garage, a coast,
  a rainy night city and more, with free (CC0) models and skies.
- **Add things (A).** Drag people, cars and props into the scene from a shelf in the World card. They show up in
  Blender renders too.
- **Version history (V).** Every render of a model, with a before-and-after slider.
- **Share (S).** Make a link to a model's picture or video, pick how long it works, or turn it off. Needs your own
  share page (see SHARE-DEPLOY.md); until then links are practice links on this computer.
- **Free auto-rig.** A person without a skeleton gets one in Blender, saved as a new version, ready to pose.
- **Blender.** Flatform finds Blender by itself (Settings shows where), and poses and rooms render in Blender too.
- **Shortcut change.** Render a still picture is now R (S is Share). T is still the turntable.
- **Version numbers.** The title bar and Settings → About show "1.1". The Windows installer is
  Flatform-Setup-1.1.0.exe.

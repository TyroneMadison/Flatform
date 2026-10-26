# Changelog

Newest first. Numbering: [VERSIONING.md](VERSIONING.md).

## 1.4 (1.4.0)

- **Several photos make ONE model.** Drop in a few photos of the same thing and Flatform builds one model from all
  of them. Want one model per photo instead? Turn on Separate models (it is off unless you choose it).
- **Angle chips on each photo.** Every photo gets a small label saying which side it shows (Front, Back, Left,
  Right). Flatform guesses; click a chip to fix it. If no photo is marked Front, the clearest one is used.
- **One price.** The cost shown is for the one model you are making, not one per photo.
- **Photo limits per service.** Tripo takes 2 to 4 sides as one job (one photo still works as before). 3D AI Studio
  takes up to 4 sides on Tripo 3.x, Hunyuan 3D Pro and Hitem3D; TRELLIS.2 uses the best photo and says so. A plain
  line tells you how many photos go in.
- **Extra photos are kept.** Photos past the limit are not sent, but they are saved with the model so you can check
  the detail later.

## 1.3 (1.3.0)

- **A joints screen anyone can use.** There is one Add joints button. It tries by itself; if it can't find the
  arms and legs it opens the placement screen and says why in one sentence. Click the 10 spots shown on a little
  body map (numbered dots, a pulsing "Click here" ring, bones that grow as you go). Mirror left to right places the
  other side for you. Rig it lights up at 10 of 10; Undo last and Start over are right there.
- **Fewer pop-up messages.** The same message no longer stacks up; it refreshes in place, and at most 3 show.
- **Test rig is always in the Pose card.** For a person it is shown from the start, greyed out with "Opens after
  your model is rigged" until the model has joints.
- **Remove part.** Click a stray floating piece, then Remove or Keep. Each removal is saved as a new version, and
  Ctrl+Z brings it back.
- **Fill small holes.** New models get their small holes and tiny cracks closed. Big openings, like the neck or a
  sleeve, are left open.
- **Part colors.** The model is split into its parts, and each part gets a color role: Primary, Secondary,
  Tertiary, Accent, Glow or Energy. The first time, every role shows in a bright test color so you can check the
  guess; click a part to change its role or lock it. One color wheel per role; Glow and Energy have a strength,
  Energy a pulse. Blender renders use the same parts and colors.
- **Draw your own Warframe on paper.** The Drawing kit has Download template (a 7 page sheet to print). Draw,
  take photos of the pages, and drop them in: Flatform reads them, cleans them up and shows a quick check (missing
  front, arms touching the body, drawing outside the box) before you start. All the views from one sheet go into
  one model, and the color map page sets the starting part colors.
- **Drawing tips at upload.** A tips card sits beside the drop zone with Download template, and Flatform tells you
  when a photo is a template page ("Template detected").

## 1.2 (1.2.0)

- **Night City you can see the model in.** The glow is turned way down and the signs and lamps are dimmer, so a
  shiny spot on the wet street no longer washes out the whole picture.
- **A tidier tools panel.** Start over is three matching buttons; every button in the panel looks the same; long
  labels wrap instead of being cut off. The export line says plainly where files go ("Saves to: folder > tennogen >
  Body_d.png and 5 more"), the 3D file is named after your model, and there is an Open folder button.
- **Plain words everywhere.** Every screen, message and error is in everyday words. The small grey help lines are
  hidden to keep things calm; Settings > Look > Show help text brings them back. Hover any control for a short tip.
- **Tripo detail that just works.** Low detail models go from 500 to 10,000 pieces, starting at 5,000. Saved values
  are kept inside what Tripo allows, Ready to build warns you when a choice limits the detail, and if Tripo says no
  you get one plain sentence with Details if you want them.
- **Undo note.** After a change a small note under the top bar ("Pose changed · Undo") lets you take it back; it
  fades after 4 seconds.
- **Free look, and the colour wheel works.** A Free look button lets you spin, zoom and move round the scene; Reset
  view (or F) brings it back. Picking a colour now really colours the model, in the app and in Blender renders.
- **Auto-rig that holds together.** Add joints finds the arms, legs and head from the model's own shape, so armoured
  Tripo models no longer tear or smear when posed. Armour plates move whole with the limb they sit on. If the limbs
  can't be found, Flatform says so and lets you click the chin, groin, elbows, wrists, knees and ankles instead.
  Rigging runs on its own: the model on screen stays as it is until the version with joints is ready and checked.
- **Reset scene goes back to version 1**, the model from before joints. The versions with joints stay under Versions.
- **Undo you can trust.** Ctrl+Z, the Undo buttons and the undo note share one history that covers poses, moments,
  adding joints and Reset scene.
- **Test rig looks the part.** A Look button picks the place, light, time of day, fog, rain and glow, and the Test
  rig now looks like your main scene, with Fast or High picture. Key caps in the corner show the controls, a short
  How to play card helps the first time, and Photo (or P) pauses for a polished, true-to-life still. It no longer
  opens to a black view on slow computers.
- **A picture of every room.** The World picker shows each place as a picture card; hover a card to read about it.
- **Same rooms for cars and Warframes.** Both pick from one list of rooms, each checked to fit a real car. Scenes
  saved with an old car backdrop open in the closest room.
- **Time stamp on every render.** Pictures and videos get the start time (New York time) in the bottom-right corner,
  in their file names and in History. Turn it off under Render for clean pictures.

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

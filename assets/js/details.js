// Course detail view: every lecture of a course and what is happening to it. The actual view
// logic now lives in src/view/courseDetails.ts (typed, no hidden globals); this just supplies the
// pieces that are not real modules yet (checkCourse/courseDir from engine.js, prepError from
// app.js) the same way every other phase of this rewrite has bridged old globals into new modules.

var courseDetail = require("./dist/view/courseDetails.js").createCourseDetail({
  translate: translate,
  formatSpeed: ui.formatSpeed,
  showView: ui.showView,
  toast: ui.toast,
  checkCourse: checkCourse,
  courseDir: courseDir,
  prepError: prepError,
  storeFromManifest: storeFromManifest
});

// A ring buffer of network activity (API calls, per-range download attempts, retries, failures)
// that the course details view's debug console reads from. Exists so a failure can be diagnosed
// from what actually happened on the wire, instead of guessing from a one-line error message.

var devlog = (function() {
  var LIMIT = 1000;
  var entries = [];
  var seq = 0;

  function add(courseId, level, text) {
    var entry = { id: ++seq, courseId: String(courseId || ""), level: level, text: text, at: Date.now() };
    entries.push(entry);
    if (entries.length > LIMIT) entries.shift();
    $(document).trigger("devlog:add", entry);
    return entry;
  }

  return {
    info: function(courseId, text) { return add(courseId, "info", text); },
    warn: function(courseId, text) { return add(courseId, "warn", text); },
    error: function(courseId, text) { return add(courseId, "error", text); },
    forCourse: function(courseId) {
      courseId = String(courseId || "");
      return entries.filter(function(e) { return e.courseId == courseId; });
    },
    clear: function(courseId) {
      courseId = String(courseId || "");
      entries = entries.filter(function(e) { return e.courseId != courseId; });
    }
  };
})();

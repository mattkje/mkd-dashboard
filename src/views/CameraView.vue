<script setup>
// The camera's own dashboard, served through this dashboard's reverse proxy (/cam-ui/).
// Because it loads over this origin's HTTPS, its microphone (push-to-talk) works. It renders
// full-bleed so it reads as this dashboard's own page, the way an agent server's pages do.
</script>

<template>
  <iframe
    class="cam-frame"
    src="/cam-ui/"
    title="Camera"
    allow="microphone; camera; autoplay"
  ></iframe>
</template>

<style scoped>
.cam-frame {
  display: block;
  border: 0;
  background: transparent;
  width: 100%;
  /* fill the area under the top nav (nav is ~38px tall + 28px margin) down to the viewport */
  height: calc(100vh - 110px);
  min-height: 520px;
}
</style>

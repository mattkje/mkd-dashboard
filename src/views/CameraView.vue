<script setup>
// The camera's own dashboard, served through this dashboard's reverse proxy (/cam-ui/).
// Because it loads over this origin's HTTPS, its microphone (push-to-talk) works.
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
  width: 100%;
  height: calc(100vh - 120px);
  min-height: 480px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: #000;
}
</style>

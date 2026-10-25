<script setup lang="ts">
import { ref } from 'vue';
defineProps<{ connected: boolean; loading: boolean }>();
const emit = defineEmits<{ connect: [key: string]; disconnect: [] }>();
const input = ref('');
function submit() { const key = input.value; input.value = ''; emit('connect', key); }
</script>
<template>
  <section class="connection" aria-label="管理连接">
    <div v-if="connected" class="connection-ready"><span><i class="status-dot" />管理端已连接</span><button class="text-button" @click="emit('disconnect')">断开连接</button></div>
    <form v-else id="connect-form" @submit.prevent="submit">
      <label for="internal-key">管理密钥</label>
      <input id="internal-key" v-model="input" type="password" autocomplete="off" placeholder="输入管理密钥" required maxlength="1000" :disabled="loading">
      <button type="submit" :disabled="loading || !input.trim()">连接</button>
    </form>
  </section>
</template>

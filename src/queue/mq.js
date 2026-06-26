// RabbitMQ connection + channel management. Two durable queues split mail
// ingestion: mail.new (live) drains fast, mail.old (historical) drains slowly.
// Durable + persistent messages mean a crash resumes where it left off.
import amqp from "amqplib";
import { config } from "../config.js";

export const QUEUES = { NEW: "mail.new", OLD: "mail.old" };

let conn = null;
let pubChannel = null;

async function getConnection() {
  if (conn) return conn;
  conn = await amqp.connect(config.rabbitmqUrl);
  conn.on("error", () => { conn = null; pubChannel = null; });
  conn.on("close", () => { conn = null; pubChannel = null; });
  return conn;
}

async function assertQueues(ch) {
  await ch.assertQueue(QUEUES.NEW, { durable: true });
  await ch.assertQueue(QUEUES.OLD, { durable: true });
}

// Shared publisher channel (used by the live poller + backlog producer).
export async function getChannel() {
  if (pubChannel) return pubChannel;
  const c = await getConnection();
  pubChannel = await c.createChannel();
  await assertQueues(pubChannel);
  return pubChannel;
}

// Dedicated consumer channel so mail.new and mail.old get independent prefetch.
export async function createConsumerChannel(prefetch = 1) {
  const c = await getConnection();
  const ch = await c.createChannel();
  await assertQueues(ch);
  await ch.prefetch(prefetch);
  return ch;
}

export async function publish(queue, payload) {
  const ch = await getChannel();
  const ok = ch.sendToQueue(queue, Buffer.from(JSON.stringify(payload)), {
    persistent: true,
  });
  if (!ok) await new Promise((res) => ch.once("drain", res)); // backpressure
}

export async function closeMq() {
  try { if (pubChannel) await pubChannel.close(); } catch { /* ignore */ }
  try { if (conn) await conn.close(); } catch { /* ignore */ }
  pubChannel = null;
  conn = null;
}

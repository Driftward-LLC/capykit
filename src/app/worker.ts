import { loadHostedConfig, redactOperationalValue } from "./config.js";

const config = loadHostedConfig();
console.log(JSON.stringify({ service: "capykit-worker", status: "ready", database: redactOperationalValue(config.databaseUrl), note: "Worker skeleton only; GitHub App access and isolated execution are downstream ENG-123/ENG-125 work." }));

import { createConsola, type LogLevel, LogLevels } from "consola";

function getConfiguredLogLevel(): LogLevel {
  const rawLevel = process.env.LOG_LEVEL ?? process.env.CONSOLA_LEVEL;
  if (!rawLevel) {
    return LogLevels.info;
  }

  const numericLevel = Number.parseInt(rawLevel, 10);
  if (!Number.isNaN(numericLevel)) {
    return numericLevel as LogLevel;
  }

  const levelName = rawLevel.toLowerCase() as keyof typeof LogLevels;
  return (LogLevels[levelName] ?? LogLevels.info) as LogLevel;
}

export const consola = createConsola({
  formatOptions: {
    colors: true,
    dateTime: true,
  },
  level: getConfiguredLogLevel(),
});

export function isDebugLoggingEnabled() {
  return consola.level >= LogLevels.debug;
}

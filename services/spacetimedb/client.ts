export const DEFAULT_SPACETIMEDB_URI = "https://maincloud.spacetimedb.com";

export interface SpacetimeDBServiceOptions {
  uri: string;
  databaseName: string;
  /** Application client identity token, not an administrative CLI token. */
  token?: string;
}

/** The subset shared by generated SpacetimeDB connection builders. */
export interface SpacetimeDBConnectionBuilder {
  withUri(uri: string): unknown;
  withDatabaseName(databaseName: string): unknown;
  withToken(token: string): unknown;
}

/** Read values already loaded by the host. This function never opens an env file. */
export function readSpacetimeDBConfig(
  env: Readonly<Record<string, string | undefined>>,
): SpacetimeDBServiceOptions {
  return validateConfig({
    uri: env.SPACETIMEDB_URI?.trim() || DEFAULT_SPACETIMEDB_URI,
    databaseName: env.SPACETIMEDB_DATABASE ?? "",
    ...(env.SPACETIMEDB_TOKEN?.trim()
      ? { token: env.SPACETIMEDB_TOKEN.trim() }
      : {}),
  });
}

function validateConfig(options: SpacetimeDBServiceOptions): SpacetimeDBServiceOptions {
  const uri = options.uri.trim();
  const databaseName = options.databaseName.trim();
  if (!databaseName) {
    throw new Error("Set SPACETIMEDB_DATABASE to the published database name.");
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("SPACETIMEDB_URI must be an absolute HTTP(S) or WS(S) URL.");
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error("SPACETIMEDB_URI must use HTTP(S) or WS(S).");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Supply the client token separately from SPACETIMEDB_URI.");
  }

  const token = options.token?.trim();
  return { uri, databaseName, ...(token ? { token } : {}) };
}

/** Constructing/configuring the service makes no network requests. */
export function createSpacetimeDBService(options: SpacetimeDBServiceOptions) {
  const config = validateConfig(options);

  return {
    /** Configure a fresh generated builder while preserving its schema-specific type. */
    configureConnection<TBuilder extends SpacetimeDBConnectionBuilder>(
      builder: TBuilder,
    ): TBuilder {
      builder.withUri(config.uri);
      builder.withDatabaseName(config.databaseName);
      if (config.token) builder.withToken(config.token);
      return builder;
    },
  };
}

export type SpacetimeDBService = ReturnType<typeof createSpacetimeDBService>;

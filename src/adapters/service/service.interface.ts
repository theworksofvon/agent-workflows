export interface ServiceSpec {
  label: string;
  nodePath: string;
  entryPath: string;
  cwd: string;
  logDir: string;
}

export interface ServiceManagerPort {
  readonly name: "launchd" | "systemd";
  unitPath(spec: ServiceSpec): string;
  render(spec: ServiceSpec): string;
  /** Writes and starts the unit; returns the unit path. */
  install(spec: ServiceSpec): Promise<string>;
  uninstall(spec: ServiceSpec): Promise<void>;
}

export interface ServiceDeps {
  run: (cmd: string, args: string[]) => Promise<void>;
  home: string;
  writeFile: (p: string, s: string) => void;
  mkdir: (p: string) => void;
  rm: (p: string) => void;
  uid: number;
}

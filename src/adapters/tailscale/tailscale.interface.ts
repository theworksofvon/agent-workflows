export interface TailscalePort {
  /** Enables Funnel for the port and returns the public https URL. */
  funnelOn(port: number): Promise<string>;
  funnelOff(port: number): Promise<void>;
  /** Reads the public URL from status only; never enables Funnel. */
  currentUrl(): Promise<string>;
}

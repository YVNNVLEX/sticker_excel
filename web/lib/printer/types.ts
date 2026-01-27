export type PrinterStatus = {
  available: boolean;
  status:
    | "ready"
    | "offline"
    | "error"
    | "unknown"
    | "unavailable"
    | "unsupported";
  name?: string;
};

export type ClubCard = {
  id: number;
  barcode?: string;
  code?: string;
  client?: string;
  telephone?: string;
  email?: string;
  date_fin?: string | null;
  statut?: string | null;
  points?: number | null;
  balance?: number | null;
  programName?: string;
};

export type ClubSuggestion = ClubCard & { score?: number };

export type ColumnDef = {
  key:
    | "code"
    | "barcode"
    | "client"
    | "email"
    | "telephone"
    | "points"
    | "date_fin"
    | "statut";
  label: string;
  accessor: (card: ClubCard) => unknown;
  mandatory?: boolean;
  format?: (value: unknown) => string;
};

export type ColumnStat = {
  key: ColumnDef["key"];
  nonEmpty: number;
  ratio: number;
};

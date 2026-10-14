export interface CrisisResource {
  name: string;
  detail: string;
  actions: { label: string; href: string }[];
}

export const CRISIS_RESOURCES: CrisisResource[] = [
  {
    name: "988 Suicide & Crisis Lifeline",
    detail: "United States · free, confidential, any hour",
    actions: [
      { label: "Call 988", href: "tel:988" },
      { label: "Text 988", href: "sms:988" },
    ],
  },
  {
    name: "Find a Helpline",
    detail: "Outside the US · free helplines in your country",
    actions: [{ label: "findahelpline.com", href: "https://findahelpline.com" }],
  },
];

export const SEP_ORIGIN = "https://plato.stanford.edu/";

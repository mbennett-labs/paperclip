import type { MissionView } from "@paperclipai/shared";
import { api } from "./client";

export const missionApi = {
  get: (companyId: string, issueId: string) =>
    api.get<MissionView>(`/companies/${companyId}/mission/${issueId}`),
};

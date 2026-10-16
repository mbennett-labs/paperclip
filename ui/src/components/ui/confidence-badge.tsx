import { Badge } from "./badge";
import { type DataConfidence, CONFIDENCE_DISPLAY } from "@paperclipai/shared";
import { Info } from "lucide-react";

interface ConfidenceBadgeProps {
  confidence: DataConfidence;
  showDescription?: boolean;
}

const colorMap: Record<string, string> = {
  green: "border-green-500 text-green-600",
  amber: "border-amber-500 text-amber-600",
  orange: "border-orange-500 text-orange-600",
  purple: "border-purple-500 text-purple-600",
  red: "border-red-500 text-red-600",
  gray: "border-gray-400 text-gray-500",
};

export function ConfidenceBadge({ confidence, showDescription }: ConfidenceBadgeProps) {
  const display = CONFIDENCE_DISPLAY[confidence];
  if (!display) return null;

  const colors = colorMap[display.color] ?? colorMap.gray;

  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="outline" className={`text-[10px] ${colors}`}>
        {display.label}
      </Badge>
      {showDescription && (
        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
          <Info className="h-2.5 w-2.5" />
          {display.description}
        </span>
      )}
    </span>
  );
}

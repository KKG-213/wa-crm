import { cn } from "@/lib/utils";

type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

export function Skeleton({ className, ...props }: SkeletonProps) {
  return <div className={cn("skeleton rounded-xl", className)} {...props} />;
}

export function StatCardSkeleton() {
  return (
    <div className="bg-card border border-border rounded-2xl p-5 flex flex-col gap-4">
      <Skeleton className="w-9 h-9" />
      <div className="space-y-1.5">
        <Skeleton className="h-7 w-16" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}

export function TableRowSkeleton({ cols = 5 }: { cols?: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-4 w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  );
}

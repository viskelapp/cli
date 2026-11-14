type ClassValue = string | null | undefined;

type ConfigVariants<T> = {
    [Axis in keyof T]?: keyof T[Axis] | null | undefined;
};

type Config<T> = {
    variants?: T;
    defaultVariants?: ConfigVariants<T>;
};

export type VariantProps<Component extends (...args: never) => string> = Omit<
    NonNullable<Parameters<Component>[0]>,
    'class' | 'className'
>;

export function cva<T extends Record<string, Record<string, ClassValue>>>(
    base: string,
    config?: Config<T>,
) {
    return (props?: ConfigVariants<T> & { className?: string }) =>
        [base, ...Object.values(props ?? {})].filter(Boolean).join(' ');
}

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-transparent text-[13px] font-medium ring-offset-background transition-[background-color,color,border-color,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-[inset_0_1px_hsl(var(--primary-foreground)/0.12),0_1px_1px_hsl(var(--foreground)/0.16)] hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-[inset_0_1px_hsl(0_0%_100%/0.12)] hover:bg-destructive/90',
        outline: 'border-input bg-background shadow-[0_1px_1px_hsl(var(--foreground)/0.025)] hover:border-border-strong hover:bg-accent hover:text-accent-foreground',
        secondary: 'border-border bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3 py-1.5',
        sm: 'h-8 px-2.5 text-xs',
        lg: 'h-9 px-4',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} type={asChild ? undefined : (type ?? 'button')} {...props} />;
  }
);
Button.displayName = 'Button';

export { buttonVariants };

'use client';

import Image from 'next/image';
import { useState } from 'react';
import { ShoppingBasket } from 'lucide-react';

export function ProductImage({
  src,
  alt,
  sizes,
  priority = false,
  className = '',
}: {
  src?: string;
  alt: string;
  sizes: string;
  priority?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <div
      className={`relative isolate grid overflow-hidden bg-muted ${className}`}
    >
      <div
        className="grid place-items-center text-muted-foreground"
        aria-hidden="true"
      >
        <ShoppingBasket className="size-9" strokeWidth={1.5} />
      </div>
      {src && !failed && (
        <Image
          src={src}
          alt={alt}
          fill
          sizes={sizes}
          priority={priority}
          onError={() => setFailed(true)}
          className="z-10 object-contain p-3"
        />
      )}
    </div>
  );
}

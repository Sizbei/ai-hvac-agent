/**
 * Safe area utilities for mobile devices with notches/home indicators.
 * Add these classes to global CSS or use via tailwind.
 */

export const safeAreaClasses = {
  top: 'safe-top',
  bottom: 'safe-bottom',
  left: 'safe-left',
  right: 'safe-right',
};

// CSS to add to globals.css:
/*
.safe-top {
  padding-top: env(safe-area-inset-top);
}

.safe-bottom {
  padding-bottom: env(safe-area-inset-bottom);
}

.safe-left {
  padding-left: env(safe-area-inset-left);
}

.safe-right {
  padding-right: env(safe-area-inset-right);
}

@media (max-width: 768px) {
  .safe-top {
    padding-top: max(env(safe-area-inset-top), 1rem);
  }

  .safe-bottom {
    padding-bottom: max(env(safe-area-inset-bottom), 1rem);
  }
}
*/

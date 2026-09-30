import 'preact';

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'md-filled-button': any;
      'md-filled-tonal-button': any;
      'md-outlined-button': any;
      'md-text-button': any;
      'md-icon-button': any;
      'md-checkbox': any;
      'md-linear-progress': any;
      'md-outlined-text-field': any;
    }
  }
}

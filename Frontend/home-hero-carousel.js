(() => {
  const slide = document.getElementById('homeHeroSlide');
  const title = document.getElementById('home-title');
  const lede = document.querySelector('.home-hero__lede');
  if (!slide || !title || !lede) return;

  const highlights = [
    {
      title: 'Build AI features into the products your customers use.',
      description: 'One developer platform for chat, vision, image generation and more—with a live model catalog, published rates and APIs you can test before you integrate.'
    },
    {
      title: 'Add conversational AI to your product.',
      description: 'Build chat and reasoning experiences with authenticated API requests, streaming support and models you can review in the live catalog.'
    },
    {
      title: 'Turn images and documents into useful answers.',
      description: 'Explore vision and OCR capabilities for image-grounded responses and document extraction, with model details available before you build.'
    },
    {
      title: 'Create new visual experiences with image generation.',
      description: 'Find image-generation models in the catalog, compare published rates and connect through the documented API.'
    },
    {
      title: 'Choose models with clear capabilities and rates.',
      description: 'Review catalog readiness, supported inputs and outputs, and published model pricing before selecting a workload.'
    },
    {
      title: 'Move from your first request to a production workflow.',
      description: 'Test the API, keep credentials on your server and review account usage as your integration grows.'
    }
  ];

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const intervalMs = 4500;
  let activeIndex = 0;
  let timer = null;
  let transitionTimer = null;
  let pausedByInteraction = false;

  const stopTimer = () => {
    window.clearTimeout(timer);
    timer = null;
  };

  const stopTransition = () => {
    window.clearTimeout(transitionTimer);
    transitionTimer = null;
    slide.classList.remove('is-exiting', 'is-entering');
  };

  const scheduleNext = () => {
    stopTimer();
    if (reducedMotion.matches || pausedByInteraction || document.hidden || highlights.length < 2) return;
    timer = window.setTimeout(showNext, intervalMs);
  };

  const renderSlide = (index, animate = true) => {
    activeIndex = (index + highlights.length) % highlights.length;
    const highlight = highlights[activeIndex];
    title.textContent = highlight.title;
    lede.textContent = highlight.description;
    slide.setAttribute('aria-label', `Headline: ${highlight.title}`);
    slide.classList.remove('is-exiting', 'is-entering');
    if (animate && !reducedMotion.matches) {
      void slide.offsetWidth;
      slide.classList.add('is-entering');
    }
  };

  const showNext = () => {
    if (pausedByInteraction || document.hidden) {
      scheduleNext();
      return;
    }
    slide.classList.remove('is-entering');
    slide.classList.add('is-exiting');
    window.clearTimeout(transitionTimer);
    transitionTimer = window.setTimeout(() => {
      renderSlide(activeIndex + 1);
      scheduleNext();
    }, reducedMotion.matches ? 0 : 280);
  };

  slide.addEventListener('pointerenter', () => {
    pausedByInteraction = true;
    stopTimer();
  });

  slide.addEventListener('pointerleave', () => {
    pausedByInteraction = false;
    scheduleNext();
  });

  slide.addEventListener('focusin', () => {
    pausedByInteraction = true;
    stopTimer();
  });

  slide.addEventListener('focusout', (event) => {
    if (slide.contains(event.relatedTarget)) return;
    pausedByInteraction = false;
    scheduleNext();
  });

  document.addEventListener('visibilitychange', () => {
    stopTransition();
    scheduleNext();
  });

  reducedMotion.addEventListener?.('change', (event) => {
    if (event.matches) stopTransition();
    scheduleNext();
  });

  scheduleNext();
})();

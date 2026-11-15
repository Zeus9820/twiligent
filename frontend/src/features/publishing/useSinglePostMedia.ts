import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, RefObject } from 'react';

function clearInput(inputRef: RefObject<HTMLInputElement | null>): void {
  if (inputRef.current) inputRef.current.value = '';
}

export function useSinglePostMedia() {
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const loadFile = useCallback((picked: File) => {
    setFile(picked);
    setFilePreview(URL.createObjectURL(picked));
  }, []);
  useEffect(() => () => { if (filePreview) URL.revokeObjectURL(filePreview); }, [filePreview]);

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    loadFile(picked);
  };

  const handleCoverSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setCoverFile(picked);
    setCoverPreview(URL.createObjectURL(picked));
  };

  const clearFile = () => {
    setFile(null);
    setFilePreview(null);
    clearInput(fileInputRef);
  };

  const clearCover = () => {
    setCoverFile(null);
    setCoverPreview(null);
    clearInput(coverInputRef);
  };

  return {
    file, filePreview, coverFile, coverPreview, fileInputRef, coverInputRef,
    loadFile, handleFileSelect, handleCoverSelect, clearFile, clearCover,
  };
}

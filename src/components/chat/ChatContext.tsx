import { Children, ReactNode, createContext, useRef, useState } from "react";
import { string } from "zod";
import { useToast } from "../ui/use-toast";
import { useMutation } from "@tanstack/react-query";
import { trpc } from "@/app/_trpc/client";
import { INFINITE_QUERY_LIMIT } from "@/config/infinite-query";
import { Stream } from "stream";

// Define a type for the response object that will be provided by the ChatContext.
type StreamResponse = {
  addMessage: () => void;
  message: string;
  handleInputChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  isLoading: boolean;
};

// Create a context for sharing state and functions related to chat.
export const ChatContext = createContext<StreamResponse>({
  addMessage: () => {},
  message: "",
  handleInputChange: () => {},
  isLoading: false,
});

// Define the props expected by the ChatContextProvider component.
interface Props {
  fileId: string;
  children: ReactNode;
}

// ChatContextProvider component that provides chat-related functionality to its children.
export const ChatContextProvider = ({ fileId, children }: Props) => {
  // State for the message input field and loading indicator.
  const [message, setMessage] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // Access the trpc context for making API calls.
  const utils = trpc.useContext();

  // Use the useToast hook for displaying toast messages.
  const { toast } = useToast();

  // Create a ref to store a backup of the message.
  const backupMessage = useRef("");

  // Use the useMutation hook to define a sendMessage mutation.
  const { mutate: sendMessage } = useMutation({
    // Function to send a message to the server.
    mutationFn: async ({ message }: { message: string }) => {
      // Send a POST request to the server.
      const response = await fetch("/api/message", {
        method: "POST",
        body: JSON.stringify({
          fileId,
          message,
        }),
      });

      // Check if the response is not OK (e.g., HTTP error).
      if (!response.ok) {
        throw new Error("Failed to send message");
      }

      // Return the response body.
      return response.body;
    },
    // Function to execute before making the mutation.
    onMutate: async ({ message }) => {
      // Store the current message as a backup.
      backupMessage.current = message;
      // Clear the message input field.
      setMessage("");

      // Step 1: Cancel any ongoing getFileMessages requests.
      await utils.getFileMessages.cancel();

      // Step 2: Get the previous messages data.
      const previousMessages = utils.getFileMessages.getInfiniteData();

      // Step 3: Update the infinite data with the new message.
      utils.getFileMessages.setInfiniteData(
        { fileId, limit: INFINITE_QUERY_LIMIT },
        (old) => {
          // If there's no existing data, initialize it.
          if (!old) {
            return {
              pages: [],
              pageParams: [],
            };
          }

          // Update the latest page with the new message.
          let newPages = [...old.pages];
          let latestPage = newPages[0]!;

          latestPage.messages = [
            {
              createdAt: new Date().toISOString(),
              id: crypto.randomUUID(),
              text: message,
              isUserMessage: true,
            },
            ...latestPage.messages,
          ];

          newPages[0] = latestPage;

          // Return the updated data.
          return {
            ...old,
            pages: newPages,
          };
        }
      );

      // Set loading state to true.
      setIsLoading(true);

      // Return an object with previousMessages data.
      return {
        previousMessages:
          previousMessages?.pages.flatMap((page) => page.messages) ?? [],
      };
    },
    // Function to execute when the mutation succeeds.
    onSuccess: async (stream) => {
      // Loading message from AI in real-time.
      setIsLoading(false);

      // Handle cases where the stream is not available.
      if (!stream) {
        return toast({
          title: "There was a problem sending this message",
          description: "Please refresh this page and try again",
          variant: "destructive",
        });
      }

      // Read the stream data.
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let done = false;
      // Accumulated response.
      let accResponse = "";

      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        const chuckValue = decoder.decode(value);

        accResponse += chuckValue;

        // Append the chunk to the actual message.
        utils.getFileMessages.setInfiniteData(
          { fileId, limit: INFINITE_QUERY_LIMIT },
          (old) => {
            if (!old) return { pages: [], pageParams: [] };

            let isAiResponseCreated = old.pages.some((page) =>
              page.messages.some((message) => message.id === "ai-response")
            );
            let updatedPages = old.pages.map((page) => {
              if (page === old.pages[0]) {
                let updatedMessages;
                if (!isAiResponseCreated) {
                  updatedMessages = [
                    {
                      createdAt: new Date().toISOString(),
                      id: "ai-response",
                      text: accResponse,
                      isUserMessage: false,
                    },
                    ...page.messages,
                  ];
                } else {
                  updatedMessages = page.messages.map((message) => {
                    if (message.id === "ai-response") {
                      return {
                        ...message,
                        text: accResponse,
                      };
                    }
                    return message;
                  });
                }

                return {
                  ...page,
                  messages: updatedMessages,
                };
              }
              return page;
            });
            return { ...old, pages: updatedPages };
          }
        );
      }
    },
    // Function to execute when the mutation encounters an error.
    onError: (_, __, context) => {
      // Restore the backup message to the input field.
      setMessage(backupMessage.current);
      // Set the previousMessages data.
      utils.getFileMessages.setData(
        { fileId },
        { messages: context?.previousMessages ?? [] }
      );
    },
    // Function to execute when the mutation settles (regardless of success or failure).
    onSettled: async () => {
      // Reset loading state.
      setIsLoading(false);

      // Invalidate the getFileMessages query to trigger a refetch.
      await utils.getFileMessages.invalidate({ fileId });
    },
  });

  // Function to handle changes in the message input field.
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value);
  };

  // Function to add a message.
  const addMessage = () => sendMessage({ message });

  // Provide the chat-related functions and state through the ChatContext.
  return (
    <ChatContext.Provider
      value={{ addMessage, message, handleInputChange, isLoading }}
    >
      {children}
    </ChatContext.Provider>
  );
};
